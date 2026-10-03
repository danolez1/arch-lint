import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mergeConfigs, resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import { canonicalId, findRule } from "../../src/arch/registry";
import { runRules } from "../../src/arch/run";
import type { Config } from "../../src/arch/types";
import { check, checkProject } from "./helpers";

const GROUP = [
  "dynamic-module-source-forbidden",
  "environment-adapter-required",
  "logger-callback-forbidden",
  "logger-construction-boundary",
  "no-direct-clinical-log-argument",
  "no-image-body-upload",
  "no-mobile-image-body-upload",
  "phi-safe-logger-required",
  "phi-safe-mobile-logger-required",
  "safe-log-event-required",
  "safe-log-scalar-source-required",
  "static-log-message",
  "static-logger-service",
  "tenant-bypass-boundary",
];

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

// A compact logger module with the shape the pinned-hash approval expects.
const LOGGER_LINES = [
  "const LOG_REDACTION_TOKENS = Object.freeze({ field: '[REDACTED]', message: '[MESSAGE-REDACTED]' } as const);",
  `const LOG_FALLBACK_RECORD = '{"level":"error","service":"logger","msg":"log.record-failed"}\\n';`,
  "const LOG_EVENT_NAME_SET = new Set<string>(['backup.complete', 'api.listening']);",
  "const LOG_SERVICE_NAMES = new Set(['standalone', 'app-api']);",
  "function redactFields(fields: Record<string, unknown> | undefined, event: string) {",
  "  return fields ? { event } : {};",
  "}",
  "function safeEventName(value: string): string {",
  "  return LOG_EVENT_NAME_SET.has(value) ? value : LOG_REDACTION_TOKENS.message;",
  "}",
  "function safeServiceName(value: string): string {",
  "  return LOG_SERVICE_NAMES.has(value) ? value : LOG_REDACTION_TOKENS.field;",
  "}",
  "function writeLogRecord(",
  "  level: string,",
  "  service: string,",
  "  message: string,",
  "  fields: Record<string, unknown> | undefined,",
  `  destination: "stdout" | "stderr"`,
  "): void {",
  "  try {",
  "    const event = safeEventName(message);",
  "    const line = JSON.stringify({",
  "      ...redactFields(fields, event),",
  "      ts: new Date().toISOString(),",
  "      level,",
  "      service: safeServiceName(service),",
  "      msg: event,",
  "    });",
  "    process[destination].write(`${line}\\n`);",
  "  } catch {",
  "    try {",
  "      process[destination].write(LOG_FALLBACK_RECORD);",
  "    } catch {}",
  "  }",
  "}",
  "export function writeRedactedLine(message: string, fields?: Record<string, unknown>): void {",
  `  writeLogRecord("info", "standalone", message, fields, "stdout");`,
  "}",
  `export function createLogger(service: string) {`,
  `  return { info: (msg: string, fields?: Record<string, unknown>) => writeLogRecord("info", service, msg, fields, "stdout") };`,
  "}",
];
const CORE_LOGGER = LOGGER_LINES.join("\n");
const REDACT_LINE =
  "return LOG_EVENT_NAME_SET.has(value) ? value : LOG_REDACTION_TOKENS.message;";

const CORE_PACKAGE = "@app/core";
const CORE_LOGGER_FILE = "packages/core/src/logger.ts";

// Approved worker source: the logger call starts at line 6, column 3.
const OCR_WORKER = [
  'import { logger } from "../lib/logger.ts";',
  "export async function readPage(payload: { text: string }) {",
  "  await Promise.resolve();",
  "  const unrelated = 1;",
  "  void unrelated;",
  '  logger.info("ocr.page-read", { chars: payload.text.length });',
  "}",
].join("\n");
const OCR_WORKER_FILE = "services/api/src/workers/ocr.worker.ts";

const EVENTS = [
  "api.listening",
  "backup.complete",
  "dir.lookup-failed",
  "extract.batch-complete",
  "images.restore-complete",
  "ocr.page-final-failure",
  "ocr.page-read",
  "ocr.provider-fallback",
  "upload.cleanup-failed",
];

const BASE_OPTIONS: Record<string, unknown> = {
  eventNames: EVENTS,
  corePackage: CORE_PACKAGE,
  loggerModulePattern: "(?:^|/)lib/logger(?:\\.ts)?$",
  loggerFactoryFiles: ["services/*/src/lib/logger.ts"],
  coreLoggerFile: CORE_LOGGER_FILE,
  coreLoggerSha256: sha256(CORE_LOGGER),
  coreIndexFile: "packages/core/src/index.ts",
  internalDbNames: ["internalDb", "getDb"],
  envKeyMapperFile: "packages/env/src/create-service-env.ts",
  envKeyMapperFunction: "createServiceEnv",
  envChildSpreadFile: "packages/db/src/postgres-command.ts",
  envChildSpreadFunction: "postgresCommandConnection",
  rawEnvAllowlist: {
    "packages/db/scripts/migrate.ts": { "11:43": ["DATABASE_URL"] },
  },
  operationalScalarFields: {
    "api.listening": ["port"],
    "extract.batch-complete": ["grounded", "ungrounded", "usedModel"],
    "images.restore-complete": ["matching", "missing", "restored"],
    "ocr.page-read": ["chars"],
    "upload.cleanup-failed": ["failures", "orphaned", "settled"],
  },
  safeLogScalarSources: {
    [`${OCR_WORKER_FILE}:ocr.page-read:chars`]: {
      call: "6:3",
      expression: "payload.text.length",
    },
  },
  approvedLogScalarSourceSha256: {
    [OCR_WORKER_FILE]: sha256(OCR_WORKER),
    "services/api/src/index.ts": sha256("pinned index"),
    "services/api/src/operations/restore-images.ts": sha256("pinned restore"),
    "services/api/src/workers/upload-cleanup.worker.ts":
      sha256("pinned cleanup"),
  },
};

const LAYERS = {
  routes: ["services/api/src/routes/"],
  services: ["services/api/src/services/"],
  mobile: ["apps/mobile/lib/"],
};

interface Setup {
  options?: Record<string, unknown>;
  config?: Config;
  files?: Record<string, string>;
  /** Replaces the default base options instead of merging into them. */
  bare?: boolean;
}

async function lint(file: string, source: string, setup: Setup = {}) {
  const options = setup.bare
    ? (setup.options ?? {})
    : { ...BASE_OPTIONS, ...setup.options };
  const config = resolveConfig(
    mergeConfigs(
      { layers: LAYERS, ...setup.config },
      { rules: { "static-log-message": { level: "error", options } } }
    )
  );
  const { violations } = await runRules({
    root: "/virtual",
    config,
    fs: memoryFileSystem({ ...setup.files, [file]: source }),
    only: GROUP,
  });
  return violations;
}

async function rules(
  file: string,
  source: string,
  setup: Setup = {}
): Promise<string[]> {
  return (await lint(file, source, setup)).map((item) => item.rule);
}

const API = "services/api/src/services/example.ts";
const dollar = "$";

const DART_SINK_IMPORTS = [
  "import 'dart:async';",
  "import 'dart:core' as core;",
  "import 'dart:developer' as developer;",
  "import 'dart:io';",
  "import 'dart:io' as io;",
  "import 'package:flutter/foundation.dart';",
  "import 'package:flutter/foundation.dart' as foundation;",
].join("\n");

const withDartSinkImports = (source: string) =>
  `${DART_SINK_IMPORTS}\n${source}`;

test("registered ids", () => {
  for (const id of GROUP) assert.equal(findRule(id)?.id, id);
  assert.equal(canonicalId("static-log-message"), "static-log-message");
});

test("logger fixture contains the line the tampering test replaces", () => {
  assert.ok(CORE_LOGGER.includes(REDACT_LINE));
});

// Parity cases: TypeScript

test("rejects raw output without matching comments or string contents", async () => {
  assert.deepEqual(
    await rules(
      API,
      [
        '// console.info("patient", patient);',
        'const example = "process.stdout.write(ocrText)";',
        'console["info"]("patient", patient);',
        'process.stderr["write"]("failed");',
      ].join("\n")
    ),
    ["phi-safe-logger-required", "phi-safe-logger-required"]
  );
  assert.deepEqual(
    await rules(API, 'writeRedactedLine("backup.complete");'),
    []
  );
});

test("allows raw output only inside the exact core adapters", async () => {
  assert.deepEqual(await rules(CORE_LOGGER_FILE, CORE_LOGGER), []);
  const nonRedactingLogger = CORE_LOGGER.replace(REDACT_LINE, "return value;");
  assert.notEqual(nonRedactingLogger, CORE_LOGGER);
  assert.ok(
    (await rules(CORE_LOGGER_FILE, nonRedactingLogger)).includes(
      "phi-safe-logger-required"
    )
  );
  assert.deepEqual(
    await rules(
      CORE_LOGGER_FILE,
      [
        "function writeLogRecord(destination, patientName) {",
        "  const line = JSON.stringify(patientName);",
        `  process[destination].write(\`${dollar}{line}\\n\`);`,
        "}",
      ].join("\n")
    ),
    ["phi-safe-logger-required"]
  );
  assert.deepEqual(
    await rules(
      CORE_LOGGER_FILE,
      'function unrelated(destination: "stdout") { process[destination].write("unsafe"); }'
    ),
    ["phi-safe-logger-required"]
  );
  assert.deepEqual(
    await rules(
      CORE_LOGGER_FILE,
      'function outer() { function writeLogRecord(destination: "stdout") { process[destination].write(LOG_FALLBACK_RECORD); } }'
    ),
    ["phi-safe-logger-required"]
  );
});

test("rejects console and process writer aliases", async () => {
  const source = [
    "const output = console;",
    "const leak = output.log;",
    'leak("patient");',
    "const stream = process.stdout;",
    "const { write } = stream;",
    'write("patient");',
    "const boundLeak = console.error.bind(console);",
    'boundLeak("patient");',
    'console.warn.call(console, "patient");',
    'console[method]("patient");',
    "const { stdout: directOutput } = process;",
    'directOutput.write("patient");',
    'import { stdout as importedOutput } from "node:process";',
    'importedOutput.write("patient");',
    'globalThis.console.log("patient");',
    'process.stdout[method]("patient");',
    'Reflect.apply(console.log, console, ["patient"]);',
    '(0, console.log)("patient");',
  ].join("\n");
  const violations = await rules(API, source);
  assert.ok(violations.length >= 11);
  assert.ok(violations.includes("phi-safe-logger-required"));
});

test("rejects raw callback sinks and nested sink containers", async () => {
  const source = [
    "items.forEach(console.log);",
    "const object = { sink: console.log };",
    'object.sink("patient");',
    "const array = [console];",
    'array[0].log("patient");',
    "const nested = { first: { stream: process.stdout } };",
    'nested.first.stream.write("patient");',
    "const runtime = process;",
    'runtime.stdout.write("patient");',
    "const globalRuntime = globalThis.process;",
    'globalRuntime.stderr.write("patient");',
    "const invoke = Reflect.apply;",
    'invoke(console.log, console, ["patient"]);',
    "const reflection = Reflect;",
    "const invokeAgain = reflection.apply;",
    'invokeAgain(console.error, console, ["patient"]);',
    "run({ sink: console.warn });",
    "run([console.error]);",
  ].join("\n");
  const violations = await rules(API, source);
  assert.ok(violations.length >= 10);
  assert.ok(violations.includes("phi-safe-logger-required"));
});

test("rejects raw sinks carried through assignments, branches, returns, spreads, and tags", async () => {
  const cases = [
    'const holder: any = {}; holder.sink = console.log; holder.sink("PATIENT-8492");',
    'const sink = enabled ? console.log : console.error; sink("PATIENT-8492");',
    'function sinkFactory() { return console.log; } sinkFactory()("PATIENT-8492");',
    'const sinks = [...[console.log]]; sinks[0]("PATIENT-8492");',
    "new Handler(console.log);",
    "console.log`PATIENT-8492`;",
  ];
  for (const source of cases) {
    assert.ok(
      (await rules(API, source)).includes("phi-safe-logger-required"),
      source
    );
  }
});

test("rejects raw sink references in transport syntax", async () => {
  const cases = [
    "const sink = console.log || console.error;",
    "const sink = console.log ?? console.error;",
    "const sink = enabled && console.log;",
    "let sink; sink ??= console.log;",
    "const factory = () => console.log;",
    "function run(sink = console.log) {}",
    "class Handler { static sink = console.log; }",
    "export default console.log;",
    "let sink; ({ sink } = { sink: console.log });",
    "let sink; [sink] = [console.log];",
  ];
  for (const source of cases) {
    assert.ok(
      (await rules(API, source)).includes("phi-safe-logger-required"),
      source
    );
  }
  assert.ok(
    (
      await rules(
        "services/api/src/services/example.tsx",
        "const view = <Button onClick={console.log} />;"
      )
    ).includes("phi-safe-logger-required")
  );
  assert.equal(
    (await rules(API, 'console.log("first"); console.error("second");')).filter(
      (rule) => rule === "phi-safe-logger-required"
    ).length,
    2
  );
});

test("rejects reflective, process, file-descriptor, and third-party output", async () => {
  const cases = [
    'Reflect.get(globalThis, "console").log(patientName);',
    'Reflect.get(globalThis, "process").stdout.write(patientName);',
    "process._rawDebug(patientName);",
    "process.emitWarning(patientName);",
    'import { writeSync } from "node:fs"; writeSync(1, patientName);',
    'import * as output from "node:console"; output.log(patientName);',
    'import { Console as RawConsole } from "node:console"; import { createWriteStream } from "node:fs"; const output = new RawConsole(createWriteStream("/tmp/app.log")); output.log(patientName);',
    'import pino from "pino"; pino().info(patientName);',
    'import { debuglog } from "node:util"; debuglog("app")(patientName);',
    'import * as util from "node:util"; util.debuglog("app")(patientName);',
    "Bun.stdout.write(patientBytes);",
    "Bun.stderr.write(patientBytes);",
    'import { writeFile } from "node:fs/promises"; await writeFile("/tmp/app.log", patientName);',
    'import * as fs from "node:fs"; await fs.promises.writeFile("/tmp/app.log", patientName);',
    'await Bun.write("/tmp/app.log", patientName);',
  ];
  for (const source of cases) {
    assert.ok(
      (await rules(API, source)).includes("phi-safe-logger-required"),
      source
    );
  }
});

test("rejects logger references in transport syntax", async () => {
  const cases = [
    "const sink = logger.info || logger.error;",
    "const factory = () => logger;",
    "function run(sink = logger.info) {}",
    "let sink; ({ sink } = { sink: logger.info });",
  ];
  for (const source of cases) {
    assert.ok(
      (
        await rules(
          API,
          `import { logger } from "../lib/logger.ts";\n${source}`
        )
      ).includes("logger-callback-forbidden"),
      source
    );
  }
});

test("rejects dynamic logger and runtime module loading", async () => {
  for (const source of [
    `const core = await import("${CORE_PACKAGE}"); core.writeRedactedLine(dynamicMessage);`,
    `const core = require("${CORE_PACKAGE}"); core.createLogger(service);`,
    'const logs = await import("../lib/logger.ts"); logs.logger.info(dynamicMessage);',
    'require("../lib/logger.ts").logger.info(dynamicMessage);',
  ]) {
    assert.ok(
      (await rules(API, source)).includes("logger-callback-forbidden"),
      source
    );
  }

  for (const source of [
    'const path = "../lib/logger.ts"; const logs = await import(path); logs.logger.info(dynamicMessage);',
    `const logs = await import(\`../lib/${dollar}{"logger"}.ts\`); logs.logger.info(dynamicMessage);`,
    'const logs = require("../lib/" + "logger.ts"); logs.logger.info(dynamicMessage);',
    `const path = "${CORE_PACKAGE}"; const core = await import(path); core.writeRedactedLine(dynamicMessage);`,
    'const runtime = require("node:" + "process"); runtime.env.JWT_SECRET;',
  ]) {
    assert.ok(
      (await rules(API, source)).includes("dynamic-module-source-forbidden"),
      source
    );
  }
});

test("rejects logger and raw capability re-exports", async () => {
  const wrapper = "services/api/src/services/wrapper.ts";
  for (const source of [
    'export { logger as audit } from "../lib/logger.ts";',
    'export * from "../lib/logger.ts";',
    `export { createLogger as make } from "${CORE_PACKAGE}";`,
  ]) {
    assert.ok(
      (await rules(wrapper, source)).includes("logger-callback-forbidden"),
      source
    );
  }
  for (const source of [
    'export { log as leak } from "node:console";',
    'export { env as environment } from "node:process";',
    'export { writeSync as leak } from "node:fs";',
  ]) {
    assert.ok(
      (await rules(wrapper, source)).includes("phi-safe-logger-required"),
      source
    );
  }
});

test("does not claim unrelated local functions and objects are logger capabilities", async () => {
  const source = [
    "function example(console: LocalConsole, process: LocalProcess) {",
    '  console.log("local");',
    "  process.env.safe;",
    "}",
    "const logger = { info(value: number) { return value; } };",
    "logger.info(1);",
    "function createLogger(value: number) { return value; }",
    "createLogger(1);",
    "function writeRedactedLine(value: number) { return value; }",
    "writeRedactedLine(1);",
  ].join("\n");
  assert.deepEqual(await rules(API, source), []);

  for (const localObject of [
    "const console = { log(value: number) { return value; } }; console.log(1);",
    "const process = { env: { safe: true } }; process.env.safe;",
    "const Bun = { env: { safe: true } }; Bun.env.safe;",
    "const globalThis = { console: { log(value: number) { return value; } } }; globalThis.console.log(1);",
  ]) {
    assert.deepEqual(await rules(API, localObject), [], localObject);
  }
  assert.deepEqual(
    await rules(
      API,
      'import * as util from "node:util"; util.format("%s", value);'
    ),
    []
  );
  assert.deepEqual(
    await rules(
      API,
      'import * as fs from "node:fs"; fs.readFileSync("/safe");'
    ),
    []
  );
  assert.deepEqual(
    await rules(
      API,
      'import * as fs from "node:fs"; fs.promises.readFile("/safe");'
    ),
    []
  );
});

test("requires literal event identifiers through object, method, and element aliases", async () => {
  const source = [
    'import { logger as audit } from "../lib/logger.ts";',
    "const copy = audit;",
    'const warn = copy["warn"];',
    'warn("ocr.provider-fallback");',
    'copy["info"](`ocr.page-read`);',
    "const bound = copy.error.bind(copy);",
    'bound("ocr.page-final-failure");',
    'copy.warn.call(copy, "dir.lookup-failed");',
    'copy[method]("ocr.page-read");',
    'copy.error("Patient Ada Lovelace");',
    'const dynamicMessage = "ocr.page-read";',
    "warn(dynamicMessage);",
  ].join("\n");
  const violations = await rules(API, source);
  assert.ok(violations.includes("logger-callback-forbidden"));
  assert.ok(violations.includes("safe-log-event-required"));
  assert.ok(violations.includes("static-log-message"));
});

test("requires literal event identifiers through standalone writer aliases", async () => {
  const source = [
    `import { writeRedactedLine as write } from "${CORE_PACKAGE}";`,
    "const output = write;",
    'output("backup.complete", { count: 2 });',
    'output("Patient Ada Lovelace");',
    "output(dynamicMessage);",
  ].join("\n");
  const violations = await rules(
    "services/api/src/operations/example.ts",
    source
  );
  assert.ok(violations.includes("logger-callback-forbidden"));
  assert.ok(violations.includes("safe-log-event-required"));
  assert.ok(violations.includes("static-log-message"));
});

test("tracks factory results, logger-module imports, and transported loggers", async () => {
  const source = [
    'import { audit } from "../lib/logger.ts";',
    `import { createLogger } from "${CORE_PACKAGE}";`,
    'const local = createLogger("app-api");',
    "const object = { local };",
    "const array = [audit];",
    "local.info(dynamicMessage);",
    "object.local.info(dynamicMessage);",
    "array[0].info(dynamicMessage);",
    "(0, audit.info)(dynamicMessage);",
  ].join("\n");
  const violations = await rules("services/api/src/lib/logger.ts", source);
  assert.equal(
    violations.filter((rule) => rule === "static-log-message").length,
    4
  );
  assert.ok(violations.includes("logger-callback-forbidden"));
});

test("tracks namespace and nested logger destructuring and rejects logger callbacks", async () => {
  const source = [
    'import * as logs from "../lib/logger.ts";',
    "const { audit } = logs;",
    "const carrier = { nested: [{ audit }] };",
    "const { nested: [entry] } = carrier;",
    "entry.audit.info(dynamicMessage);",
    "items.forEach(audit.info);",
    "run(audit);",
    "run(carrier);",
  ].join("\n");
  const violations = await rules(API, source);
  assert.ok(violations.includes("static-log-message"));
  assert.ok(violations.includes("logger-callback-forbidden"));
});

test("rejects logger assignment, conditional, constructor, and return transport", async () => {
  const cases = new Map([
    [
      "const holder: any = {}; holder.audit = logger; holder.audit.info(dynamicMessage);",
      "static-log-message",
    ],
    [
      "const record = enabled ? logger.info : logger.warn; record(dynamicMessage);",
      "static-log-message",
    ],
    ["new Handler(logger);", "logger-callback-forbidden"],
    [
      "function currentLogger() { return logger; }",
      "logger-callback-forbidden",
    ],
  ]);
  for (const [source, expectedRule] of cases) {
    assert.ok(
      (
        await rules(
          API,
          `import { logger } from "../lib/logger.ts";\n${source}`
        )
      ).includes(expectedRule),
      source
    );
  }
});

test("tracks createLogger and redacted writer destructured from the core namespace", async () => {
  const source = [
    `import * as core from "${CORE_PACKAGE}";`,
    "const { createLogger: make, writeRedactedLine: write } = core;",
    'make("app-api");',
    "write(dynamicMessage);",
    "items.forEach(make);",
    "items.forEach(write);",
  ].join("\n");
  const violations = await rules("services/api/src/routes/example.ts", source);
  assert.ok(violations.includes("logger-construction-boundary"));
  assert.ok(violations.includes("static-log-message"));
  assert.ok(violations.includes("logger-callback-forbidden"));
});

test("finds clinical text carried through aliases and permits aggregate lengths", async () => {
  const source = [
    'import { logger } from "../lib/logger.ts";',
    "const first = ocrText;",
    "const second = first;",
    'logger.info(\n  "ocr.page-read",\n  { value: second }\n);',
    'logger.info("ocr.page-read", { chars: payload.text.length });',
  ].join("\n");
  assert.ok(
    (await rules(API, source)).includes("no-direct-clinical-log-argument")
  );
});

test("recognizes destructured logger methods and element-access clinical text", async () => {
  const source = [
    'import { logger } from "../lib/logger.ts";',
    "const { info: record } = logger;",
    'record("ocr.page-read", { value: payload["text"] });',
  ].join("\n");
  const violations = await rules(API, source);
  assert.ok(violations.includes("logger-callback-forbidden"));
  assert.ok(violations.includes("no-direct-clinical-log-argument"));
});

test("finds clinical text carried through object and array destructuring", async () => {
  const source = [
    'import { logger } from "../lib/logger.ts";',
    "const { ocrText: objectValue } = payload;",
    "const [arrayValue] = ocrText;",
    'logger.info("ocr.page-read", { value: objectValue });',
    'logger.info("ocr.page-read", { value: arrayValue });',
  ].join("\n");
  assert.deepEqual(await rules(API, source), [
    "no-direct-clinical-log-argument",
    "no-direct-clinical-log-argument",
  ]);
});

test("allows only literal logger construction in service adapters", async () => {
  const adapter = "services/api/src/lib/logger.ts";
  assert.deepEqual(
    await rules(
      adapter,
      `import { createLogger } from "${CORE_PACKAGE}"; createLogger("app-api");`
    ),
    []
  );
  assert.deepEqual(
    await rules(
      adapter,
      `import { createLogger } from "${CORE_PACKAGE}"; createLogger(serviceName);`
    ),
    ["static-logger-service"]
  );
  assert.deepEqual(
    await rules(
      "services/api/src/routes/example.ts",
      `import { createLogger } from "${CORE_PACKAGE}"; createLogger("route");`
    ),
    ["logger-construction-boundary"]
  );
  const violations = await rules(
    "services/api/src/routes/example.ts",
    [
      `import { createLogger as make } from "${CORE_PACKAGE}";`,
      'make("route");',
      `import * as core from "${CORE_PACKAGE}";`,
      "const factory = core.createLogger;",
      'factory("route");',
    ].join("\n")
  );
  assert.equal(
    violations.filter((rule) => rule === "logger-construction-boundary").length,
    2
  );
  assert.ok(violations.includes("logger-callback-forbidden"));
});

test("rejects raw environment access outside the environment boundary", async () => {
  const mapper = "packages/env/src/create-service-env.ts";
  const migrate = "packages/db/scripts/migrate.ts";
  assert.deepEqual(await rules(API, 'process["env"].SECRET'), [
    "environment-adapter-required",
  ]);
  assert.deepEqual(
    await rules(
      mapper,
      [
        "export function createServiceEnv(keys: readonly string[]) {",
        '  return Object.fromEntries(keys.map((key) => [key, process.env[key] === "" ? undefined : process.env[key]]));',
        "}",
      ].join("\n")
    ),
    []
  );
  for (const mutation of ['key = "JWT_SECRET";', 'key += "_SECRET";']) {
    assert.ok(
      (
        await rules(
          mapper,
          [
            "export function createServiceEnv(keys: string[]) {",
            `  return Object.fromEntries(keys.map((key) => { ${mutation} return [key, process.env[key]]; }));`,
            "}",
          ].join("\n")
        )
      ).includes("environment-adapter-required"),
      mutation
    );
  }
  assert.deepEqual(
    await rules(
      mapper,
      `${"\n".repeat(25)}    const leakedValueHere = process.env.JWT_SECRET;`
    ),
    ["environment-adapter-required"]
  );
  assert.deepEqual(
    await rules(
      mapper,
      [
        "export function createServiceEnv(keys: readonly string[]) {",
        "  return Object.fromEntries(keys.map((key) => [key, process.env.JWT_SECRET]));",
        "}",
      ].join("\n")
    ),
    ["environment-adapter-required"]
  );
  assert.deepEqual(
    await rules(
      "packages/db/src/postgres-command.ts",
      [
        "export function postgresCommandConnection(password: string) {",
        "  return { database: 'safe', env: { ...process.env, PGPASSWORD: password } };",
        "}",
      ].join("\n")
    ),
    []
  );
  assert.deepEqual(
    await rules(
      migrate,
      `${"\n".repeat(10)}const pool = new Pool({ connectionString: process.env.DATABASE_URL });`
    ),
    []
  );
  assert.deepEqual(
    await rules(
      migrate,
      `${"\n".repeat(10)}const pool = new Pool({ connectionString: process.env.JWT_SECRET });`
    ),
    ["environment-adapter-required"]
  );
  assert.deepEqual(
    await rules(
      migrate,
      `${"\n".repeat(11)}const pool = new Pool({ connectionString: process.env.DATABASE_URL });`
    ),
    ["environment-adapter-required"]
  );
  const environmentViolations = await rules(
    API,
    [
      'import { env as importedEnv } from "node:process";',
      "const { env: environment } = process;",
      "const runtime = process;",
      "const first = importedEnv.JWT_SECRET;",
      "const second = environment.JWT_SECRET;",
      "const third = runtime.env.JWT_SECRET;",
      "const fourth = globalThis.process.env.JWT_SECRET;",
    ].join("\n")
  );
  assert.ok(
    environmentViolations.filter(
      (rule) => rule === "environment-adapter-required"
    ).length >= 4
  );
  for (const source of [
    "let environment; ({ env: environment } = process); environment.JWT_SECRET;",
    'const environment = Reflect.get(process, "env"); environment.JWT_SECRET;',
    "const runtime = ({ process }).process; runtime.env.JWT_SECRET;",
    "const runtime = Bun; runtime.env.JWT_SECRET;",
    "const secretKey = dynamicSecret; (process as any).env[secretKey];",
  ]) {
    assert.ok(
      (await rules(API, source)).includes("environment-adapter-required"),
      source
    );
  }
  for (const source of [
    "process['e' + 'nv'].JWT_SECRET;",
    "process['env' as 'env'].JWT_SECRET;",
    "process[dynamic].JWT_SECRET;",
    "globalThis.Bun.env.JWT_SECRET;",
    "global.process.env.JWT_SECRET;",
    'Reflect.get(process, "e" + "nv").JWT_SECRET;',
    'const get = Reflect.get; get(process, "env").JWT_SECRET;',
    'const processModule = await import("node:process"); processModule.env.JWT_SECRET;',
    'const processModule = require("node:process"); processModule.env.JWT_SECRET;',
    'import processModule = require("node:process"); processModule.env.JWT_SECRET;',
    "const { process: runtime } = globalThis; runtime.env.JWT_SECRET;",
    "function runtime() { return process; }",
    'Reflect.get(globalThis, "Bun").env.JWT_SECRET;',
    "import.meta.env.JWT_SECRET;",
    'process.getBuiltinModule("node:process").env.JWT_SECRET;',
    'import { createRequire } from "node:module"; const runtimeRequire = createRequire(import.meta.url); runtimeRequire("node:process").env.JWT_SECRET;',
    "const { ...runtime } = process; runtime.env.JWT_SECRET;",
    "const runtime = enabled ? process : process; runtime.env.JWT_SECRET;",
  ]) {
    assert.ok(
      (await rules(API, source)).includes("environment-adapter-required"),
      source
    );
  }
});

test("rejects clinical numeric identifiers relabeled as allowed telemetry", async () => {
  for (const identifier of [
    "patientId",
    "patientReference",
    "mrn",
    "medicalRecordNumber",
    "accountNumber",
    "memberId",
    "policyNumber",
    "passportNumber",
    "licenseNumber",
  ]) {
    assert.ok(
      (
        await rules(
          API,
          `import { logger } from "../lib/logger.ts"; logger.info("api.listening", { port: ${identifier} });`
        )
      ).includes("no-direct-clinical-log-argument"),
      identifier
    );
  }
});

test("allows operational scalars only at reviewed event call sites", async () => {
  assert.ok(
    !(await rules(OCR_WORKER_FILE, OCR_WORKER)).includes(
      "safe-log-scalar-source-required"
    )
  );

  for (const source of [
    'logger.info("api.listening", { port: patient.id });',
    'const value = patient.id; logger.info("api.listening", { port: value });',
    'const { id: port } = patient; logger.info("api.listening", { port });',
    'logger.info("api.listening", { port: patientIds[0] });',
    'logger.info("extract.batch-complete", { usedModel: patient.deceased });',
    'logger.info("ocr.page-read", { ...patientTelemetry });',
  ]) {
    assert.ok(
      (
        await rules(
          API,
          `import { logger } from "../lib/logger.ts";\n${source}`
        )
      ).includes("safe-log-scalar-source-required"),
      source
    );
  }

  const spoofedApprovedSources = new Map([
    [
      "services/api/src/index.ts",
      'import { logger } from "./lib/logger.ts"; function leak(patient: any) { const env = { PORT: patient.id }; logger.info("api.listening", { port: env.PORT }); }',
    ],
    [
      OCR_WORKER_FILE,
      'import { logger } from "../lib/logger.ts"; function leak(patient: any) { const payload = { text: { length: patient.id } }; logger.info("ocr.page-read", { chars: payload.text.length }); }',
    ],
    [
      "services/api/src/operations/restore-images.ts",
      'import { logger } from "../lib/logger.ts"; function leak(patient: any, result: any) { result.matching = patient.id; logger.info("images.restore-complete", { matching: result.matching, missing: result.missing, restored: result.restored }); }',
    ],
    [
      "services/api/src/workers/upload-cleanup.worker.ts",
      'import { logger } from "../lib/logger.ts"; function leak(patient: any, result: any) { result.failures = patient.id; logger.error("upload.cleanup-failed", { settled: result.settled, orphaned: result.orphaned, failures: result.failures }); }',
    ],
  ]);
  for (const [file, source] of spoofedApprovedSources) {
    assert.ok(
      (await rules(file, source)).includes("safe-log-scalar-source-required"),
      file
    );
  }
});

test("rejects internal database handles in route modules", async () => {
  assert.deepEqual(
    await rules(
      "services/api/src/routes/example.ts",
      'import { internalDb } from "../lib/db.ts";'
    ),
    ["tenant-bypass-boundary"]
  );
});

test("rejects every image-body upload path", async () => {
  const route = "services/api/src/routes/new-upload.ts";
  assert.deepEqual(await rules(route, "body: t.File()"), [
    "no-image-body-upload",
  ]);
  assert.deepEqual(
    await rules(
      "services/api/src/services/new-upload.ts",
      "await image.arrayBuffer()"
    ),
    ["no-image-body-upload"]
  );
  assert.deepEqual(
    await rules("services/api/src/routes/batches.ts", "body: t.File()"),
    ["no-image-body-upload"]
  );
  for (const source of [
    "await request.formData()",
    "await request.blob()",
    "await request.arrayBuffer()",
    "await request.bytes()",
    "await request.body?.getReader()",
    "new FormData()",
    "new Blob([bytes])",
  ]) {
    assert.deepEqual(
      await rules(route, source),
      ["no-image-body-upload"],
      source
    );
  }
});

// Parity cases: Dart

const MOBILE_UPLOAD = "apps/mobile/lib/sync/upload.dart";
const MOBILE = "apps/mobile/lib/example.dart";
const SINK = "phi-safe-mobile-logger-required";

test("rejects mobile multipart body uploads", async () => {
  assert.deepEqual(
    await rules(
      MOBILE_UPLOAD,
      "final task = UploadTask(url: api, fields: {'file': name});"
    ),
    ["no-mobile-image-body-upload"]
  );
  assert.deepEqual(
    await rules(MOBILE_UPLOAD, "final file = MultipartFile.fromBytes(bytes);"),
    ["no-mobile-image-body-upload"]
  );
  for (const source of [
    "final body = FormData.fromMap({'file': bytes});",
    "final request = MultipartRequest('POST', api);",
    "final task = MultiUploadTask(url: api, files: files);",
  ]) {
    assert.deepEqual(
      await rules(MOBILE_UPLOAD, source),
      ["no-mobile-image-body-upload"],
      source
    );
  }
  assert.deepEqual(
    await rules(
      MOBILE_UPLOAD,
      "final task = UploadTask(url: signed, post: 'binary');"
    ),
    []
  );
});

test("rejects mobile debug and developer sinks", async () => {
  const source = withDartSinkImports(
    [
      "print('capture');",
      "debugPrint('capture');",
      "developer.log('capture');",
      "final sink = developer.log;",
      "sink('capture');",
    ].join("\n")
  );
  assert.deepEqual(await rules(MOBILE, source), [SINK, SINK, SINK, SINK]);
});

test("rejects sinks executed inside string interpolation", async () => {
  assert.deepEqual(
    await rules(
      MOBILE,
      withDartSinkImports(
        [
          'final value = "',
          dollar,
          "{print('capture')} ",
          dollar,
          '{"',
          dollar,
          "{developer.log('nested')}",
          '"}";',
        ].join("")
      )
    ),
    [SINK, SINK]
  );
});

test("rejects call indirection and callback sinks", async () => {
  const source = withDartSinkImports(
    [
      "print.call('capture');",
      "developer.log.call('capture');",
      "final sink = debugPrint;",
      "sink.call('capture');",
      "runZonedGuarded(body, print);",
    ].join("\n")
  );
  assert.deepEqual(await rules(MOBILE, source), [SINK, SINK, SINK, SINK]);
});

test("rejects named callbacks, map-held sinks, and optional chained calls", async () => {
  const source = withDartSinkImports(
    [
      "run(onError: debugPrint);",
      "run(onError: developer.log);",
      "final handlers = {'error': debugPrint};",
      "handlers['error']('capture');",
      "debugPrint?.call('capture');",
      "debugPrint.call.call('capture');",
      "developer.log?.call('capture');",
    ].join("\n")
  );
  assert.deepEqual(await rules(MOBILE, source), [
    SINK,
    SINK,
    SINK,
    SINK,
    SINK,
    SINK,
  ]);
});

test("rejects mobile sink fields, returns, null checks, casts, and synchronous output", async () => {
  const cases = [
    "final handler = Handler(); handler.sink = debugPrint; handler.sink('capture');",
    "class Handler { static final sink = debugPrint; } Handler.sink('capture');",
    "final handlers = {'error': debugPrint}; handlers['error']!('capture');",
    "(debugPrint as void Function(String))('capture');",
    "Function sinkFactory() { return debugPrint; }",
    "import 'dart:io'; stdout.writeln('capture');",
    "debugPrintSynchronously('capture');",
    "Zone.current.print('capture');",
    "final zoneSink = Zone.current.print; zoneSink('capture');",
    "foundation.debugPrint('capture');",
    "foundation.debugPrintSynchronously('capture');",
    "foundation.debugPrintStack(label: 'capture');",
    "core.print('capture');",
    "io.stderr.write('capture');",
    "FlutterError.dumpErrorToConsole(details);",
    "final prefixed = foundation.debugPrint; prefixed('capture');",
  ];
  for (const source of cases) {
    assert.ok(
      (await rules(MOBILE, withDartSinkImports(source))).includes(SINK),
      source
    );
  }
});

test("rejects imported developer and extended output methods", async () => {
  for (const source of [
    'import "dart:developer" show log; log("patient");',
    'import "dart:developer"; log("patient");',
    "debugPrintThrottled('patient');",
    "foundation.debugPrintThrottled('patient');",
    "stdout.writeAll(['patient']);",
    "stdout.writeCharCode(65);",
    "stderr.add(bytes);",
    "io.stderr.addStream(stream);",
  ]) {
    assert.ok(
      (await rules(MOBILE, withDartSinkImports(source))).includes(SINK),
      source
    );
  }
});

test("ignores sink names inside strings and nested comments", async () => {
  const source = [
    "// debugPrint('capture');",
    "/* print('capture'); /* developer.log('capture'); */ */",
    "final text = \"debugPrint('capture')\";",
    "final raw = r'''developer.log('capture')''';",
    "object.print('safe member');",
    "math.log(10);",
    "ledger.log(10);",
    "final stdout = LocalWriter(); stdout.writeln('safe');",
    "class Audit { void log(String value) {} }",
    "void print(Object? value) { store(value); }",
  ].join("\n");
  assert.deepEqual(await rules(MOBILE, source), []);
});

test("does not claim local Dart bindings are output capabilities", async () => {
  for (const source of [
    'class LocalDeveloper { void log(String value) {} } final developer = LocalDeveloper(); developer.log("safe");',
    'void record(LocalLogger developer) { developer.log("safe"); }',
    'void record(LocalFoundation foundation) { foundation.debugPrint("safe"); }',
    'void record(LocalIo io) { io.stderr.write("safe"); }',
    'class LocalCore { void print(String value) {} } final core = LocalCore(); core.print("safe");',
    "class FlutterError { static void presentError(Object value) {} } void record(Object value) { FlutterError.presentError(value); }",
    'void record(void Function(String) print) { print("safe"); }',
    'void print(Object? value) { store(value); } void main() { print("safe"); }',
  ]) {
    assert.deepEqual(await rules(MOBILE, source), [], source);
  }
});

test("with no options the analysis is inert for project-bound checks", async () => {
  const bare = { bare: true } as const;
  assert.deepEqual(
    await rules(
      API,
      'import { logger } from "../lib/logger.ts"; logger.info("anything");',
      bare
    ),
    []
  );
  assert.deepEqual(
    await rules(
      API,
      `import { createLogger } from "${CORE_PACKAGE}"; createLogger(name);`,
      bare
    ),
    []
  );
  assert.deepEqual(await rules(API, 'console.log("x");', bare), [
    "phi-safe-logger-required",
  ]);
});

test("loggerModulePattern recognizes a different logger module path", async () => {
  const source =
    'import { log } from "@app/observability"; log.info("not.registered");';
  assert.deepEqual(await rules(API, source), []);
  assert.deepEqual(
    await rules(API, source, {
      options: { loggerModulePattern: "^@app/observability$" },
    }),
    ["safe-log-event-required"]
  );
});

test("an invalid loggerModulePattern is reported as an error", async () => {
  await assert.rejects(
    lint(API, "const a = 1;", { options: { loggerModulePattern: "(" } }),
    /loggerModulePattern is not a valid regular expression/
  );
});

test("eventNames decides which messages are registered", async () => {
  const source =
    'import { logger } from "../lib/logger.ts"; logger.info("custom.event");';
  assert.deepEqual(await rules(API, source), ["safe-log-event-required"]);
  assert.deepEqual(
    await rules(API, source, { options: { eventNames: ["custom.event"] } }),
    []
  );
  assert.deepEqual(await rules(API, source, { options: { eventNames: [] } }), [
    "safe-log-event-required",
  ]);
});

test("corePackage names the package that exports the logger factory", async () => {
  const source =
    'import { createLogger } from "@other/core"; createLogger("route");';
  const routes = "services/api/src/routes/example.ts";
  assert.deepEqual(await rules(routes, source), []);
  assert.deepEqual(
    await rules(routes, source, { options: { corePackage: "@other/core" } }),
    ["logger-construction-boundary"]
  );
});

test("createLoggerExport and redactedWriterExport rename the core exports", async () => {
  const source = [
    `import { makeLogger, emit } from "${CORE_PACKAGE}";`,
    "makeLogger(name);",
    "emit(dynamic);",
  ].join("\n");
  const routes = "services/api/src/routes/example.ts";
  assert.deepEqual(await rules(routes, source), []);
  assert.deepEqual(
    await rules(routes, source, {
      options: {
        createLoggerExport: "makeLogger",
        redactedWriterExport: "emit",
      },
    }),
    [
      "logger-construction-boundary",
      "static-logger-service",
      "static-log-message",
    ]
  );
});

test("loggerFactoryFiles lists where the factory may be called", async () => {
  const source = `import { createLogger } from "${CORE_PACKAGE}"; createLogger("route");`;
  const file = "lib/logging/factory.ts";
  assert.deepEqual(await rules(file, source), ["logger-construction-boundary"]);
  assert.deepEqual(
    await rules(file, source, {
      options: { loggerFactoryFiles: ["lib/logging/*.ts"] },
    }),
    []
  );
});

test("coreLoggerFile and coreLoggerSha256 approve the exact adapter source", async () => {
  assert.deepEqual(await rules(CORE_LOGGER_FILE, CORE_LOGGER), []);
  assert.ok(
    (
      await rules(CORE_LOGGER_FILE, CORE_LOGGER, {
        options: { coreLoggerSha256: sha256("other") },
      })
    ).includes("phi-safe-logger-required")
  );
  assert.ok(
    (
      await rules(CORE_LOGGER_FILE, CORE_LOGGER, {
        options: { coreLoggerFile: "elsewhere.ts" },
      })
    ).includes("phi-safe-logger-required")
  );
  assert.ok(
    (
      await rules(CORE_LOGGER_FILE, CORE_LOGGER, {
        options: { coreLoggerSha256: "" },
      })
    ).includes("phi-safe-logger-required")
  );
});

test("coreIndexFile and coreIndexSpecifier approve the factory re-export", async () => {
  const index = "packages/core/src/index.ts";
  const source = [
    `import { createLogger, writeRedactedLine } from "${CORE_PACKAGE}";`,
    'export { createLogger, writeRedactedLine } from "./logger.ts";',
  ].join("\n");
  assert.deepEqual(await rules(index, source), []);
  const flagged = ["logger-callback-forbidden", "logger-callback-forbidden"];
  assert.deepEqual(
    await rules(index, source, { options: { coreIndexFile: "" } }),
    flagged
  );
  assert.deepEqual(
    await rules(index, source, {
      options: { coreIndexSpecifier: "./other.ts" },
    }),
    flagged
  );
  assert.deepEqual(await rules("packages/core/src/other.ts", source), flagged);
});

test("unsafeLoggerModules extends or replaces the third-party logger list", async () => {
  const pino = 'import pino from "pino"; export const log = pino();';
  const custom = 'import log from "loglevel"; log.info("x");';
  assert.deepEqual(await rules(API, pino), ["phi-safe-logger-required"]);
  assert.deepEqual(await rules(API, custom), []);
  assert.deepEqual(
    await rules(API, custom, {
      options: { unsafeLoggerModules: ["loglevel"] },
    }),
    ["phi-safe-logger-required"]
  );
  assert.deepEqual(
    await rules(API, pino, { options: { unsafeLoggerModules: ["loglevel"] } }),
    []
  );
});

test("clinicalTextNames replaces the identifiers treated as clinical text", async () => {
  const source = [
    'import { logger } from "../lib/logger.ts";',
    'logger.info("ocr.page-read", { value: chartNote });',
    'logger.info("ocr.page-read", { value: ocrText });',
  ].join("\n");
  assert.deepEqual(await rules(API, source), [
    "no-direct-clinical-log-argument",
  ]);
  assert.deepEqual(
    await rules(API, source, {
      options: { clinicalTextNames: ["chart_note"] },
    }),
    ["no-direct-clinical-log-argument"]
  );
  assert.deepEqual(
    await rules(API, source, { options: { clinicalTextNames: [] } }),
    []
  );
});

test("internalDbNames lists the handles a route may not touch", async () => {
  const source = 'import { adminDb } from "../lib/db.ts";';
  const route = "services/api/src/routes/example.ts";
  assert.deepEqual(await rules(route, source), []);
  assert.deepEqual(
    await rules(route, source, { options: { internalDbNames: ["adminDb"] } }),
    ["tenant-bypass-boundary"]
  );
  assert.deepEqual(
    await rules(route, source, { options: { internalDbNames: [] } }),
    []
  );
});

test("env boundary options approve only the named file and function", async () => {
  const source = [
    "export function createServiceEnv(keys: readonly string[]) {",
    "  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));",
    "}",
  ].join("\n");
  const mapper = "packages/env/src/create-service-env.ts";
  assert.deepEqual(await rules(mapper, source), []);
  assert.deepEqual(await rules("packages/env/src/other.ts", source), [
    "environment-adapter-required",
  ]);
  assert.deepEqual(
    await rules(mapper, source, { options: { envKeyMapperFunction: "other" } }),
    ["environment-adapter-required"]
  );
  assert.deepEqual(
    await rules(mapper, source, { options: { envKeyMapperFunction: "" } }),
    ["environment-adapter-required"]
  );
  assert.deepEqual(
    await rules(mapper, source, { options: { envKeyMapperFile: "" } }),
    ["environment-adapter-required"]
  );

  const spread = [
    "export function postgresCommandConnection(password: string) {",
    "  return { database: 'safe', env: { ...process.env, PGPASSWORD: password } };",
    "}",
  ].join("\n");
  const child = "packages/db/src/postgres-command.ts";
  assert.deepEqual(await rules(child, spread), []);
  assert.deepEqual(
    await rules(child, spread, {
      options: { envChildSpreadFunction: "other" },
    }),
    ["environment-adapter-required"]
  );
  assert.deepEqual(
    await rules(child, spread, { options: { envChildSpreadFile: "" } }),
    ["environment-adapter-required"]
  );
});

test("rawEnvAllowlist approves a key only at its exact position", async () => {
  const file = "packages/db/scripts/seed.ts";
  const read = "const url = process.env.DATABASE_URL;";
  const options = { rawEnvAllowlist: { [file]: { "2:13": ["DATABASE_URL"] } } };
  assert.deepEqual(await rules(file, `\n${read}`, { options }), []);
  assert.deepEqual(await rules(file, read, { options }), [
    "environment-adapter-required",
  ]);
  assert.deepEqual(
    await rules(file, `\nconst url = process.env.OTHER_KEY;`, { options }),
    ["environment-adapter-required"]
  );
  assert.deepEqual(await rules(file, `\n${read}`), [
    "environment-adapter-required",
  ]);
});

test("operationalScalarFields decides which event fields need a reviewed source", async () => {
  const source =
    'import { logger } from "../lib/logger.ts"; logger.info("backup.complete", { size: patient.id });';
  assert.deepEqual(await rules(API, source), []);
  assert.deepEqual(
    await rules(API, source, {
      options: { operationalScalarFields: { "backup.complete": ["size"] } },
    }),
    ["safe-log-scalar-source-required"]
  );
});

test("safeLogScalarSources pins the call position and expression", async () => {
  const sourceAt = (call: string, expression: string) => ({
    options: {
      safeLogScalarSources: {
        [`${OCR_WORKER_FILE}:ocr.page-read:chars`]: { call, expression },
      },
    },
  });
  assert.ok(
    (
      await rules(
        OCR_WORKER_FILE,
        OCR_WORKER,
        sourceAt("6:4", "payload.text.length")
      )
    ).includes("safe-log-scalar-source-required")
  );
  assert.ok(
    (
      await rules(OCR_WORKER_FILE, OCR_WORKER, sourceAt("6:3", "payload.text"))
    ).includes("safe-log-scalar-source-required")
  );
  assert.ok(
    (
      await rules(OCR_WORKER_FILE, OCR_WORKER, {
        options: { safeLogScalarSources: {} },
      })
    ).includes("safe-log-scalar-source-required")
  );
});

test("approvedLogScalarSourceSha256 rejects a changed source", async () => {
  assert.ok(
    !(await rules(OCR_WORKER_FILE, OCR_WORKER)).includes(
      "safe-log-scalar-source-required"
    )
  );
  assert.ok(
    (await rules(OCR_WORKER_FILE, `${OCR_WORKER}\n// edited`)).includes(
      "safe-log-scalar-source-required"
    )
  );
  assert.ok(
    (
      await rules(OCR_WORKER_FILE, OCR_WORKER, {
        options: { approvedLogScalarSourceSha256: {} },
      })
    ).includes("safe-log-scalar-source-required")
  );
});

test("approvedRawFileOutputs approves one write call in an unchanged source", async () => {
  const file = "services/api/src/operations/backup.ts";
  const source = [
    'import { writeFile } from "node:fs/promises";',
    "export async function save(bytes: Uint8Array) {",
    '  await writeFile("/var/backup.bin", bytes);',
    "}",
  ].join("\n");
  const approval = (text: string, calls: string[]) => ({
    options: {
      approvedRawFileOutputs: { [file]: { sha256: sha256(text), calls } },
    },
  });
  assert.deepEqual(await rules(file, source), ["phi-safe-logger-required"]);
  assert.deepEqual(await rules(file, source, approval(source, ["3:9"])), []);
  assert.deepEqual(await rules(file, source, approval(source, ["4:9"])), [
    "phi-safe-logger-required",
  ]);
  assert.deepEqual(await rules(file, source, approval("other", ["3:9"])), [
    "phi-safe-logger-required",
  ]);
});

test("layer options scope the path-bound checks and an undefined layer turns them off", async () => {
  const route = "services/api/src/routes/example.ts";
  assert.deepEqual(await rules(route, "await request.formData()"), [
    "no-image-body-upload",
  ]);
  assert.deepEqual(
    await rules(route, "await request.formData()", { config: { layers: {} } }),
    []
  );
  assert.deepEqual(
    await rules("handlers/example.ts", "await request.formData()", {
      options: { imageBodyRouteLayer: "handlers" },
      config: { layers: { handlers: ["handlers/"] } },
    }),
    ["no-image-body-upload"]
  );
  assert.deepEqual(
    await rules("handlers/example.ts", "await image.arrayBuffer()", {
      options: { imageBodyServiceLayer: "handlers" },
      config: { layers: { handlers: ["handlers/"] } },
    }),
    ["no-image-body-upload"]
  );
  assert.deepEqual(
    await rules("handlers/example.ts", "import { internalDb } from './db';", {
      options: { tenantBypassLayer: "handlers" },
      config: { layers: { handlers: ["handlers/"] } },
    }),
    ["tenant-bypass-boundary"]
  );
  assert.deepEqual(
    await rules(
      "handlers/upload.dart",
      "final file = MultipartFile.fromBytes(bytes);",
      {
        options: { mobileUploadLayer: "handlers" },
        config: { layers: { handlers: ["handlers/"] } },
      }
    ),
    ["no-mobile-image-body-upload"]
  );
  assert.deepEqual(
    await rules(MOBILE_UPLOAD, "final file = MultipartFile.fromBytes(bytes);", {
      config: { layers: {} },
    }),
    []
  );
});

test("options set on any rule of the group apply to all, and the rule's own value wins", async () => {
  const source =
    'import { logger } from "../lib/logger.ts"; logger.info("custom.event");';
  const files = { [API]: source };
  const viaOther = await checkProject("safe-log-event-required", files, {
    options: { loggerModulePattern: "(?:^|/)lib/logger(?:\\.ts)?$" },
    config: {
      rules: {
        "static-log-message": { options: { eventNames: ["custom.event"] } },
      },
    },
  });
  assert.equal(viaOther.length, 0);
  const own = await checkProject("safe-log-event-required", files, {
    options: {
      loggerModulePattern: "(?:^|/)lib/logger(?:\\.ts)?$",
      eventNames: ["x"],
    },
    config: {
      rules: {
        "static-log-message": { options: { eventNames: ["custom.event"] } },
      },
    },
  });
  assert.equal(own.length, 1);
});

test("a rule's message option replaces its own messages only", async () => {
  const violations = await lint(
    API,
    'console.log("a"); await request.formData();',
    {
      config: {
        rules: {
          "phi-safe-logger-required": {
            level: "error",
            options: { message: "Use the logger." },
          },
        },
      },
    }
  );
  const sink = violations.find((v) => v.rule === "phi-safe-logger-required");
  assert.equal(sink?.message, "Use the logger.");
  const other = (
    await check("phi-safe-logger-required", API, 'console.log("a");', {
      options: { message: "m" },
    })
  )[0];
  assert.equal(other?.message, "m");
});

test("test files are skipped through the configured test patterns", async () => {
  assert.deepEqual(
    await rules(
      "services/api/src/services/example.test.ts",
      'console.log("a");'
    ),
    []
  );
  assert.deepEqual(
    await rules("services/api/tests/example.ts", 'console.log("a");'),
    []
  );
  assert.deepEqual(
    await rules("services/api/src/services/example.ts", 'console.log("a");', {
      config: { tests: ["**/*.never"] },
    }),
    ["phi-safe-logger-required"]
  );
  const dartTest = "apps/mobile/test/sample.dart";
  assert.deepEqual(
    await rules(dartTest, withDartSinkImports("print('a');")),
    []
  );
  assert.deepEqual(
    await rules(dartTest, withDartSinkImports("print('a');"), {
      config: { tests: ["**/*.never"] },
    }),
    [SINK]
  );
});

test("exempt files, include and layer from the config are applied by the runner", async () => {
  const source = 'console.log("a");';
  const withSettings = (settings: Record<string, unknown>) => ({
    config: {
      layers: { ...LAYERS, backend: ["services/api/src/services/"] },
      rules: {
        "phi-safe-logger-required": { level: "error" as const, ...settings },
      },
    },
  });
  assert.deepEqual(
    await rules(API, source, withSettings({ exempt: { files: [API] } })),
    []
  );
  assert.deepEqual(
    await rules(
      API,
      source,
      withSettings({ exempt: { dirs: ["services/api/"] } })
    ),
    []
  );
  assert.deepEqual(
    await rules(API, source, withSettings({ include: ["other/"] })),
    []
  );
  assert.deepEqual(
    await rules(API, source, withSettings({ layer: "backend" })),
    ["phi-safe-logger-required"]
  );
  assert.deepEqual(
    await rules("lib/other.ts", source, withSettings({ layer: "backend" })),
    []
  );
});

test("typescript and dart files are both read from the project listing", async () => {
  const violations = await lint(API, 'console.log("a");', {
    files: { "apps/mobile/lib/a.dart": withDartSinkImports("print('a');") },
  });
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.rule}`),
    [`apps/mobile/lib/a.dart:${SINK}`, `${API}:phi-safe-logger-required`]
  );
});
