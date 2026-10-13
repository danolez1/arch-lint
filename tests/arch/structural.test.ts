import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareToBaseline,
  readBaseline,
  writeBaseline,
} from "../../src/arch/baseline";
import { resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import {
  unstableInterfaceChangeCounts,
  unstableInterfaceMemberIndentations,
  unstableInterfaceSignatureRanges,
} from "../../src/arch/rules/structural";
import { runRules } from "../../src/arch/run";

test("unstable-interface counts commits that change public signature lines", () => {
  const log = [
    String.fromCharCode(1) + "commit-one",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -2 +2 @@",
    "-  name: string;",
    "+  name: number;",
    String.fromCharCode(1) + "commit-two",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -3 +3 @@",
    "-  value: string;",
    "+  value: number;",
    String.fromCharCode(1) + "implementation-only",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -20 +20 @@",
    "-  const oldValue = 1;",
    "+  const newValue = 2;",
  ].join("\n");
  const counts = unstableInterfaceChangeCounts(
    log,
    new Map([["src/api.ts", [{ start: 1, end: 5 }]]])
  );
  assert.deepEqual([...counts], [["src/api.ts", 2]]);
});

test("unstable-interface counts removed public signatures but skips private ones", () => {
  const log = [
    String.fromCharCode(1) + "public-removal",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -4 +3,0 @@",
    "-  publicMethod(): void;",
    String.fromCharCode(1) + "private-removal",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -4 +3,0 @@",
    "-  #privateMethod(): void;",
  ].join("\n");
  const counts = unstableInterfaceChangeCounts(
    log,
    new Map([["src/api.ts", [{ start: 2, end: 2 }]]])
  );
  assert.deepEqual([...counts], [["src/api.ts", 1]]);
});

test("unstable-interface ignores removed method-body calls", () => {
  const log = [
    String.fromCharCode(1) + "body-call-removal",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -4 +3,0 @@",
    "-    calculate();",
  ].join("\n");
  const counts = unstableInterfaceChangeCounts(
    log,
    new Map([["src/api.ts", [{ start: 2, end: 4 }]]]),
    new Map([["src/api.ts", new Set([2])]])
  );
  assert.deepEqual([...counts], []);
});

test("unstable-interface counts removed methods without return annotations", () => {
  const log = [
    String.fromCharCode(1) + "method-removal",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -4 +3,0 @@",
    "-    run();",
  ].join("\n");
  const counts = unstableInterfaceChangeCounts(
    log,
    new Map([["src/api.ts", [{ start: 2, end: 2 }]]]),
    new Map([["src/api.ts", new Set([4])]])
  );
  assert.deepEqual([...counts], [["src/api.ts", 1]]);
});

test("unstable-interface tracks local declarations exposed through export lists", () => {
  const ranges = unstableInterfaceSignatureRanges(
    "src/api.ts",
    ["class Api {", "    run(): void {}", "}", "export { Api };"].join("\n")
  );
  assert.ok(ranges.some(({ start, end }) => start === 2 && end === 2));
});

test("unstable-interface tracks signatures behind a named default export", () => {
  const ranges = unstableInterfaceSignatureRanges(
    "src/api.ts",
    ["class Api {", "  run(): void {}", "}", "export default Api;"].join("\n")
  );
  assert.ok(ranges.some(({ start, end }) => start === 2 && end === 2));
});

test("unstable-interface tracks members of a named default class expression", () => {
  const ranges = unstableInterfaceSignatureRanges(
    "src/api.ts",
    [
      "const Api = class {",
      "  run(): void {}",
      "};",
      "export default Api;",
    ].join("\n")
  );
  assert.ok(ranges.some(({ start, end }) => start === 2 && end === 2));
});

test("unstable-interface unwraps exported class expressions", () => {
  for (const source of [
    [
      "export const Api = (class {",
      "  run(): void {}",
      "}) as new () => unknown;",
    ],
    [
      "export const Api = class {",
      "  run(): void {}",
      "} satisfies new () => unknown;",
    ],
  ]) {
    const ranges = unstableInterfaceSignatureRanges(
      "src/api.ts",
      source.join("\n")
    );
    assert.ok(ranges.some(({ start, end }) => start === 2 && end === 2));
  }
});

test("unstable-interface follows local class aliases in the exported surface", () => {
  for (const source of [
    [
      "class Impl {",
      "  run(): void {}",
      "}",
      "const Api = (Impl as typeof Impl);",
      "export default Api;",
    ],
    [
      "const Impl = class {",
      "  run(): void {}",
      "};",
      "const Api = Impl satisfies typeof Impl;",
      "export default Api;",
    ],
  ]) {
    const ranges = unstableInterfaceSignatureRanges(
      "src/api.ts",
      source.join("\n")
    );
    assert.ok(ranges.some(({ start, end }) => start === 2 && end === 2));
  }
});

test("unstable-interface ignores unexported class declarators in shared statements", () => {
  const ranges = unstableInterfaceSignatureRanges(
    "src/api.ts",
    [
      "const Api = class {",
      "  publicRun(): void {}",
      "}, Internal = class {",
      "  internalRun(): void {}",
      "};",
      "export { Api };",
    ].join("\n")
  );
  assert.ok(ranges.some(({ start, end }) => start === 2 && end === 2));
  assert.equal(
    ranges.some(({ start }) => start === 4),
    false
  );
});

test("unstable-interface infers four-space indentation for a sole removed member", () => {
  const indentations = unstableInterfaceMemberIndentations(
    "src/api.ts",
    [
      "export interface Api {",
      "}",
      "function helper() {",
      "    return 1;",
      "}",
    ].join("\n")
  );
  const log = [
    String.fromCharCode(1) + "sole-member-removal",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -2 +1,0 @@",
    "-    run();",
  ].join("\n");
  const counts = unstableInterfaceChangeCounts(
    log,
    new Map([["src/api.ts", [{ start: 1, end: 2 }]]]),
    new Map([["src/api.ts", indentations]])
  );
  assert.deepEqual([...indentations], [4]);
  assert.deepEqual([...counts], [["src/api.ts", 1]]);
});

test("unstable-interface ignores removed object-property calls", () => {
  const log = [
    String.fromCharCode(1) + "property-call-removal",
    "diff --git a/src/api.ts b/src/api.ts",
    "--- a/src/api.ts",
    "+++ b/src/api.ts",
    "@@ -4 +3,0 @@",
    "-  retry: reconnect()",
  ].join("\n");
  const counts = unstableInterfaceChangeCounts(
    log,
    new Map([["src/api.ts", [{ start: 2, end: 2 }]]])
  );
  assert.deepEqual([...counts], []);
});

test("structural detectors report configured complexity, parameters, nesting, and sizes", async () => {
  const files = {
    "src/complex.ts": [
      "export function branchy(a: boolean, b: boolean, c: boolean, d: boolean) {",
      "  if (a && b) {",
      "    if (c) {",
      "      if (d) return 1;",
      "    }",
      "  }",
      "  return 0;",
      "}",
    ].join("\n"),
  };
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cyclomatic-complexity": { level: "error", options: { max: 2 } },
      "long-parameter-list": { level: "error", options: { max: 3 } },
      "deep-nesting": { level: "error", options: { max: 2 } },
      "large-function": { level: "error", options: { maxLines: 5 } },
      "large-file": { level: "error", options: { maxLines: 6 } },
    },
  });
  const result = await runRules({
    root: "/virtual-structural",
    config,
    fs: memoryFileSystem(files),
  });
  assert.deepEqual(
    [...new Set(result.violations.map((violation) => violation.rule))].sort(),
    [
      "cyclomatic-complexity",
      "deep-nesting",
      "large-file",
      "large-function",
      "long-parameter-list",
    ]
  );
});

test("interface segregation counts methods and dependency inversion flags concrete imports", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    layers: {
      services: ["src/services/**"],
      adapters: ["src/adapters/**"],
      contracts: ["src/contracts/**"],
    },
    rules: {
      "interface-segregation": {
        level: "error",
        options: { maxMethods: 1 },
      },
      "dependency-inversion": {
        level: "error",
        options: {
          highLevelLayers: ["services"],
          implementationLayers: ["adapters"],
        },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-solid-rules",
    config,
    fs: memoryFileSystem({
      "src/services/user-service.ts": [
        'import type { SqlUserRepository } from "../adapters/sql-user-repository";',
        'import type { UserRepository } from "../contracts/user-repository";',
        "export class UserService {",
        "  constructor(readonly adapter: SqlUserRepository, readonly repo: UserRepository) {}",
        "}",
      ].join("\n"),
      "src/adapters/sql-user-repository.ts":
        "export class SqlUserRepository {}",
      "src/contracts/user-repository.ts": [
        "export interface UserRepository {",
        "  find(id: string): string;",
        "  save(id: string): void;",
        "}",
      ].join("\n"),
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, rule }) => [file, rule]),
    [
      ["src/contracts/user-repository.ts", "interface-segregation"],
      ["src/services/user-service.ts", "dependency-inversion"],
    ]
  );
});

test("dependency inversion stays inactive until its layer options are configured", async () => {
  const result = await runRules({
    root: "/virtual-unconfigured-dip",
    config: resolveConfig({ defaultLevel: "error" }),
    fs: memoryFileSystem({
      "src/service.ts":
        'import { Adapter } from "./adapter"; export class Service { adapter = new Adapter(); }',
      "src/adapter.ts": "export class Adapter {}",
    }),
  });
  assert.equal(
    result.violations.some(({ rule }) => rule === "dependency-inversion"),
    false
  );
});

test("dependency inversion follows concrete classes re-exported through barrels", async () => {
  const result = await runRules({
    root: "/virtual-dip-barrel",
    config: resolveConfig({
      defaultLevel: "off",
      layers: {
        services: ["src/services/**"],
        contracts: ["src/contracts/**"],
        adapters: ["src/adapters/**"],
      },
      rules: {
        "dependency-inversion": {
          level: "error",
          options: {
            highLevelLayers: ["services"],
            implementationLayers: ["adapters"],
          },
        },
      },
    }),
    fs: memoryFileSystem({
      "src/services/user-service.ts":
        'import { SqlUserRepository } from "../contracts"; export class UserService { adapter = new SqlUserRepository(); }',
      "src/contracts/index.ts":
        'export { SqlUserRepository } from "../adapters/sql-user-repository";',
      "src/adapters/sql-user-repository.ts":
        "export class SqlUserRepository {}",
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, rule }) => [file, rule]),
    [["src/services/user-service.ts", "dependency-inversion"]]
  );
});

test("dependency inversion follows constructor aliases exported as values", async () => {
  const result = await runRules({
    root: "/virtual-dip-class-expression",
    config: resolveConfig({
      defaultLevel: "off",
      layers: {
        services: ["src/services/**"],
        adapters: ["src/adapters/**"],
      },
      rules: {
        "dependency-inversion": {
          level: "error",
          options: {
            highLevelLayers: ["services"],
            implementationLayers: ["adapters"],
          },
        },
      },
    }),
    fs: memoryFileSystem({
      "src/services/user-service.ts": [
        'import { SqlUserRepository, ExpressRepository } from "../adapters/sql-user-repository";',
        "export class UserService {",
        "  adapter = new SqlUserRepository();",
        "  expression = new ExpressRepository();",
        "}",
      ].join("\n"),
      "src/adapters/sql-user-repository.ts": [
        "class SqlUserRepositoryImpl {}",
        "export const SqlUserRepository = (SqlUserRepositoryImpl as typeof SqlUserRepositoryImpl);",
        "const ExpressRepositoryImpl = class {};",
        "export const ExpressRepository = ExpressRepositoryImpl satisfies typeof ExpressRepositoryImpl;",
      ].join("\n"),
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, rule }) => [file, rule]),
    [["src/services/user-service.ts", "dependency-inversion"]]
  );
});

test("structural detectors ignore branches inside nested functions", async () => {
  const fs = memoryFileSystem({
    "src/nested.ts": [
      "export function outer(callback: () => void) {",
      "  const inner = () => {",
      "    if (true) return;",
      "    if (false) return;",
      "    if (true) return;",
      "  };",
      "  callback();",
      "  return inner;",
      "}",
    ].join("\n"),
  });
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cyclomatic-complexity": { level: "error", options: { max: 1 } },
    },
  });
  const result = await runRules({
    root: "/virtual-structural-nested",
    config,
    fs,
  });
  assert.equal(result.violations.length, 1);
  assert.match(
    result.violations[0]!.message,
    /inner has cyclomatic complexity 4/
  );
});

test("structural thresholds reject invalid values", async () => {
  const config = resolveConfig({
    rules: {
      "large-file": { level: "error", options: { maxLines: 0 } },
    },
  });
  await assert.rejects(
    runRules({
      root: "/virtual-structural-invalid",
      config,
      fs: memoryFileSystem({ "src/a.ts": "export {};" }),
    }),
    /maxLines must be a positive integer/
  );
});

test("structural detectors also inspect JavaScript modules", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cyclomatic-complexity": { level: "error", options: { max: 1 } },
    },
  });
  const result = await runRules({
    root: "/virtual-structural-js",
    config,
    fs: memoryFileSystem({
      "src/branch.js":
        "export function branch(a, b) { if (a) { if (b) return 1; } }",
    }),
  });
  assert.equal(result.violations[0]!.file, "src/branch.js");
  assert.equal(result.violations[0]!.rule, "cyclomatic-complexity");
});

test("abstractness flags stable concrete dependencies and accepts type-only clients", async () => {
  const files: Record<string, string> = {
    "src/database.ts": "export class Database {}",
    "src/contracts.ts": "export interface Contract {}",
    "src/base.ts": "export abstract class Base {}",
    "src/base-barrel.ts": 'export { Base } from "./base";',
    "src/contracts-barrel.ts": 'export { type Contract } from "./contracts";',
    "src/namespace-base.ts": "export abstract class Base {}",
    "src/concrete.ts": "export class Concrete {}",
    "src/concrete-type-barrel.ts":
      'export { type Concrete } from "./concrete";',
  };
  for (let index = 0; index < 10; index++) {
    files[`src/runtime-client-${index}.ts`] =
      'import { Database } from "./database";\nnew Database();';
    files[`src/type-client-${index}.ts`] =
      'import type { Contract } from "./contracts";\nlet value: Contract;';
    files[`src/base-client-${index}.ts`] =
      'import { Base } from "./base";\nclass Derived extends Base {}';
    files[`src/reexport-client-${index}.ts`] =
      'import { Contract } from "./contracts-barrel";\nlet value: Contract;';
    files[`src/namespace-client-${index}.ts`] =
      'import * as Contracts from "./namespace-base";\nclass Derived extends Contracts.Base {}';
    files[`src/concrete-type-client-${index}.ts`] =
      'import { Concrete } from "./concrete-type-barrel";\nlet value: Concrete;';
  }
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      abstractness: {
        level: "error",
        options: { minFanIn: 10, distanceThreshold: 0.8 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-abstractness-metric",
    config,
    fs: memoryFileSystem(files),
    only: ["abstractness"],
  });
  assert.deepEqual(
    result.violations.map(({ file, rule }) => [file, rule]),
    [["src/database.ts", "abstractness"]]
  );
  assert.match(result.violations[0]!.message, /A=0\.00, I=0\.00/);
});

test("cyclomatic complexity counts logical assignments", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cyclomatic-complexity": { level: "error", options: { max: 1 } },
    },
  });
  const result = await runRules({
    root: "/virtual-structural-logical-assignment",
    config,
    fs: memoryFileSystem({
      "src/branches.ts": [
        "export function branches(a: boolean | undefined) {",
        "  a ||= true;",
        "  a &&= false;",
        "  a ??= true;",
        "}",
      ].join("\n"),
    }),
  });
  assert.match(result.violations[0]!.message, /complexity 4/);
});

test("cognitive complexity weights nested flow and logical sequences", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cognitive-complexity": { level: "error", options: { max: 6 } },
    },
  });
  const result = await runRules({
    root: "/virtual-cognitive-complexity",
    config,
    fs: memoryFileSystem({
      "src/flow.ts": [
        "export function flow(a: boolean, b: boolean, c: boolean, d: boolean, e: boolean) {",
        "  if (a && b && c) {",
        "    while (d) {",
        "      if (e) return;",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    }),
  });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.message, /cognitive complexity 7/);
});

test("cognitive complexity keeps else-if nesting flat and ignores literal nullish defaults", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cognitive-complexity": { level: "error", options: { max: 5 } },
    },
  });
  const result = await runRules({
    root: "/virtual-cognitive-else-if",
    config,
    fs: memoryFileSystem({
      "src/flow.ts": [
        "export function flow(a: boolean, b: boolean, c: boolean, d: boolean, x?: boolean, y?: boolean) {",
        "  if (a) { if (b) return; }",
        "  else if (c) { if (d) return; }",
        "  const first = x ?? false;",
        "  const second = y ?? true;",
        "}",
      ].join("\n"),
    }),
  });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.message, /cognitive complexity 6/);
});

test("cognitive complexity counts labeled jumps", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cognitive-complexity": { level: "error", options: { max: 3 } },
    },
  });
  const result = await runRules({
    root: "/virtual-cognitive-jump",
    config,
    fs: memoryFileSystem({
      "src/loop.ts": [
        "export function loop(items: boolean[]) {",
        "  outer: for (const item of items) {",
        "    if (item) continue outer;",
        "  }",
        "}",
      ].join("\n"),
    }),
  });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.message, /cognitive complexity 4/);
});

test("line limits do not count the empty line after a final newline", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: { "large-file": { level: "error", options: { maxLines: 1 } } },
  });
  const result = await runRules({
    root: "/virtual-structural-lines",
    config,
    fs: memoryFileSystem({
      "src/one-line.ts": "export {};\n",
      "src/two-lines.ts": "export {};\nexport {};\n",
    }),
  });
  assert.deepEqual(
    result.violations.map((violation) => violation.file),
    ["src/two-lines.ts"]
  );
});

test("god-module and barrel-abuse use configurable structural limits", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "god-module": { level: "error", options: { maxFunctions: 1 } },
      "barrel-abuse": { level: "error", options: { maxReExports: 1 } },
    },
  });
  const result = await runRules({
    root: "/virtual-module-size",
    config,
    fs: memoryFileSystem({
      "src/module.ts":
        "export function first() {}\nexport function second() {}",
      "src/interface.ts":
        "export interface Api { first(): void; second(): void }",
      "src/index.ts": 'export * from "./one";\nexport * from "./two";',
      "src/one.ts": "export {};",
      "src/two.ts": "export {};",
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, rule }) => [file, rule]),
    [
      ["src/index.ts", "barrel-abuse"],
      ["src/module.ts", "god-module"],
    ]
  );
});

test("dead-symbols finds unused private values but preserves referenced and exported declarations", async () => {
  const result = await runRules({
    root: "/virtual-dead-symbols",
    config: resolveConfig({
      defaultLevel: "off",
      rules: { dead_symbols: "error" },
    }),
    fs: memoryFileSystem({
      "src/module.ts": [
        "function unusedFunction() {}",
        "class UnusedClass {}",
        "const unusedValue = 1;",
        "function usedFunction() {}",
        "usedFunction();",
        "const exportedAlias = 1;",
        "export { exportedAlias };",
        "export function publicFunction() {}",
        "export function container() {",
        "  function unusedNestedFunction() {}",
        "  const unusedNestedValue = 2;",
        "  const { unusedDestructuredValue } = { unusedDestructuredValue: 3 };",
        "  const usedNestedValue = 4;",
        "  function usedNestedFunction() { return usedNestedValue; }",
        "  return usedNestedFunction;",
        "  let writeOnlyNestedValue = 5;",
        "  writeOnlyNestedValue = 6;",
        "}",
        "const exportedItem = 1;",
        "export { exportedItem };",
        "export function shadowedName() {",
        "  const exportedItem = 2;",
        "  return 1;",
        "}",
      ].join("\n"),
      "src/module.test.ts": "function testOnly() {}",
      "src/types.d.ts": "declare function ambientOnly(): void;",
    }),
  });

  assert.deepEqual(
    result.violations.map(({ file, line, rule }) => [file, line, rule]),
    [
      ["src/module.ts", 1, "dead_symbols"],
      ["src/module.ts", 2, "dead_symbols"],
      ["src/module.ts", 3, "dead_symbols"],
      ["src/module.ts", 10, "dead_symbols"],
      ["src/module.ts", 11, "dead_symbols"],
      ["src/module.ts", 12, "dead_symbols"],
      ["src/module.ts", 16, "dead_symbols"],
      ["src/module.ts", 22, "dead_symbols"],
    ]
  );
});

test("dead-symbols baseline identity survives unrelated declarations and initializer edits", async () => {
  const check = (source: string) =>
    runRules({
      root: "/virtual-dead-symbol-identity",
      config: resolveConfig({
        defaultLevel: "off",
        rules: { dead_symbols: "error" },
      }),
      fs: memoryFileSystem({ "src/module.ts": source }),
    });
  const before = await check("function orphan() {};");
  const after = await check("const marker = 0;\nfunction orphan() {};");
  const beforeInitializer = await check("const orphan = 1;");
  const afterInitializer = await check("const orphan = 2;");
  const findOrphan = (violations: typeof before.violations) =>
    violations.find((violation) => violation.message.includes("orphan"));

  assert.equal(
    findOrphan(before.violations)?.identity,
    findOrphan(after.violations)?.identity
  );
  assert.match(
    findOrphan(after.violations)?.identity ?? "",
    /^src\/module\.ts:FunctionDeclaration:orphan:0$/
  );
  assert.equal(
    beforeInitializer.violations[0].identity,
    afterInitializer.violations[0].identity
  );
  assert.equal(
    afterInitializer.violations[0].identity,
    "src/module.ts:VariableDeclaration:orphan:0"
  );
});

test("dead-symbols gives distinct stable identities to bindings and block scopes", async () => {
  const check = (source: string) =>
    runRules({
      root: "/virtual-dead-symbol-scopes",
      config: resolveConfig({
        defaultLevel: "off",
        rules: { dead_symbols: "error" },
      }),
      fs: memoryFileSystem({ "src/module.ts": source }),
    });
  const before = await check(
    [
      "export function api(flag: boolean) {",
      "  const { a, b } = { a: 1, b: 2 };",
      "  if (flag) { const item = 3; } else { const item = 4; }",
      "  return flag;",
      "}",
    ].join("\n")
  );
  const after = await check(
    [
      "const marker = 0;",
      "export function api(flag: boolean) {",
      "  const { b, a } = { a: 1, b: 2 };",
      "  { const marker = 0; }",
      "  if (flag) { const item = 3; } else { const item = 4; }",
      "  return flag;",
      "}",
    ].join("\n")
  );
  const identitiesFor = (violations: typeof before.violations, name: string) =>
    violations
      .filter((violation) => violation.message.includes(`symbol ${name} `))
      .map((violation) => violation.identity)
      .sort();

  assert.equal(
    new Set(before.violations.map(({ identity }) => identity)).size,
    4
  );
  assert.deepEqual(
    identitiesFor(before.violations, "a"),
    identitiesFor(after.violations, "a")
  );
  assert.deepEqual(
    identitiesFor(before.violations, "b"),
    identitiesFor(after.violations, "b")
  );
  assert.deepEqual(
    identitiesFor(before.violations, "item"),
    identitiesFor(after.violations, "item")
  );
});

test("dead-symbols identity ignores newly referenced same-name declarations", async () => {
  const check = (source: string) =>
    runRules({
      root: "/virtual-dead-symbol-live-shadow",
      config: resolveConfig({
        defaultLevel: "off",
        rules: { dead_symbols: "error" },
      }),
      fs: memoryFileSystem({ "src/module.ts": source }),
    });
  const before = await check(
    [
      "export function api(flag: boolean) {",
      "  { const target = 1; }",
      "  return flag;",
      "}",
    ].join("\n")
  );
  const after = await check(
    [
      "export function api(flag: boolean) {",
      "  if (flag) { const target = 2; return target; }",
      "  { const target = 1; }",
      "  return flag;",
      "}",
    ].join("\n")
  );

  assert.deepEqual(
    after.violations.map(({ identity }) => identity),
    before.violations.map(({ identity }) => identity)
  );
});

test("dead-symbols baseline matches duplicate identities by finding count", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-dead-symbols-"));
  const check = (source: string) =>
    runRules({
      root: "/virtual-dead-symbol-baseline-count",
      config: resolveConfig({
        defaultLevel: "off",
        rules: { dead_symbols: "error" },
      }),
      fs: memoryFileSystem({ "src/module.ts": source }),
    });
  try {
    const oneUnused = await check(
      ["export function api() {", "  { const target = 1; }", "}"].join("\n")
    );
    writeBaseline(root, "baseline.json", oneUnused.violations);
    const insertedLive = await check(
      [
        "export function api() {",
        "  { const target = 2; console.log(target); }",
        "  { const target = 1; }",
        "}",
      ].join("\n")
    );
    const insertionComparison = compareToBaseline(
      insertedLive.violations,
      readBaseline(root, "baseline.json")
    );
    assert.equal(insertionComparison.fresh.length, 0);
    assert.equal(insertionComparison.debt, 1);
    assert.equal(insertionComparison.fixed, 0);

    const twoUnused = await check(
      [
        "export function api() {",
        "  { const target = 1; }",
        "  { const target = 1; }",
        "}",
      ].join("\n")
    );
    assert.equal(
      new Set(twoUnused.violations.map(({ identity }) => identity)).size,
      2
    );
    assert.equal(
      new Set(
        twoUnused.violations.map(({ baselineIdentity }) => baselineIdentity)
      ).size,
      1
    );
    writeBaseline(root, "baseline.json", twoUnused.violations);
    const oneReferenced = await check(
      [
        "export function api() {",
        "  { const target = 1; console.log(target); }",
        "  { const target = 1; }",
        "}",
      ].join("\n")
    );
    const referenceComparison = compareToBaseline(
      oneReferenced.violations,
      readBaseline(root, "baseline.json")
    );
    assert.equal(referenceComparison.fresh.length, 0);
    assert.equal(referenceComparison.debt, 1);
    assert.equal(referenceComparison.fixed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dead-symbols preserves the unused sibling branch identity when a binding is referenced", async () => {
  const check = (source: string) =>
    runRules({
      root: "/virtual-dead-symbol-branch-identity",
      config: resolveConfig({
        defaultLevel: "off",
        rules: { dead_symbols: "error" },
      }),
      fs: memoryFileSystem({ "src/module.ts": source }),
    });
  const before = await check(
    [
      "export function api(flag: boolean) {",
      "  if (flag) {",
      "    const item = 3;",
      "  } else {",
      "    const item = 4;",
      "  }",
      "  return flag;",
      "}",
    ].join("\n")
  );
  const after = await check(
    [
      "export function api(flag: boolean) {",
      "  if (flag) {",
      "    const item = 3;",
      "    return item;",
      "  } else {",
      "    const item = 4;",
      "  }",
      "  return flag;",
      "}",
    ].join("\n")
  );
  const elseIdentity = (violations: typeof before.violations) =>
    violations.find(({ identity }) => identity?.includes("/if:else/"))
      ?.identity;

  assert.equal(elseIdentity(before.violations), elseIdentity(after.violations));
});

test("dead-symbols keeps sibling identities when one initializer changes", async () => {
  const check = (source: string) =>
    runRules({
      root: "/virtual-dead-symbol-initializer-identity",
      config: resolveConfig({
        defaultLevel: "off",
        rules: { dead_symbols: "error" },
      }),
      fs: memoryFileSystem({ "src/module.ts": source }),
    });
  const before = await check(
    [
      "export function api() {",
      "  { const item = 1; }",
      "  { const item = 1; }",
      "}",
    ].join("\n")
  );
  const after = await check(
    [
      "export function api() {",
      "  { const item = 2; }",
      "  { const item = 1; }",
      "}",
    ].join("\n")
  );

  assert.deepEqual(
    after.violations.map(({ identity }) => identity),
    before.violations.map(({ identity }) => identity)
  );
});

test("dead-symbols preserves identities across repeated lexical scopes", async () => {
  const check = (source: string) =>
    runRules({
      root: "/virtual-dead-symbol-repeated-scopes",
      config: resolveConfig({
        defaultLevel: "off",
        rules: { dead_symbols: "error" },
      }),
      fs: memoryFileSystem({ "src/module.ts": source }),
    });
  const transitions = [
    [
      [
        "export function api() {",
        "  { const item = 1; }",
        "  { const item = 2; }",
        "}",
      ],
      [
        "export function api() {",
        "  { const item = 1; console.log(item); }",
        "  { const item = 2; }",
        "}",
      ],
    ],
    [
      [
        "export function api(flag: boolean) {",
        "  if (flag) { const item = 1; }",
        "  if (flag) { const item = 2; }",
        "  return flag;",
        "}",
      ],
      [
        "export function api(flag: boolean) {",
        "  if (flag) { const item = 1; console.log(item); }",
        "  if (flag) { const item = 2; }",
        "  return flag;",
        "}",
      ],
    ],
    [
      [
        "export function api() {",
        "  for (const item of firstItems) {}",
        "  for (const item of secondItems) {}",
        "}",
      ],
      [
        "export function api() {",
        "  for (const item of firstItems) { console.log(item); }",
        "  for (const item of secondItems) {}",
        "}",
      ],
    ],
    [
      [
        "export function api() {",
        "  try { const item = 1; } catch {}",
        "  try { const item = 2; } catch {}",
        "}",
      ],
      [
        "export function api() {",
        "  try { const item = 1; console.log(item); } catch {}",
        "  try { const item = 2; } catch {}",
        "}",
      ],
    ],
    [
      [
        "export function api() {",
        "  { const item = 1; }",
        "  { const item = 1; }",
        "}",
      ],
      [
        "export function api() {",
        "  { const item = 1; console.log(item); }",
        "  { const item = 1; }",
        "}",
      ],
    ],
  ];

  for (const [beforeSource, afterSource] of transitions) {
    const before = await check(beforeSource.join("\n"));
    const after = await check(afterSource.join("\n"));
    const beforeItemIdentities = before.violations.map(
      ({ identity }) => identity
    );

    assert.equal(after.violations.length, 1);
    assert.equal(after.violations[0].identity, beforeItemIdentities[1]);
  }
});

test("module-cohesion identifies unrelated exported declarations", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "module-cohesion": {
        level: "error",
        options: { minExports: 3, maxComponents: 1 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-module-cohesion",
    config,
    fs: memoryFileSystem({
      "src/misc.ts": [
        "export function formatCurrency(value: number) { return value; }",
        "export function validateEmail(value: string) { return value; }",
        "export function parseToken(value: string) { return value; }",
      ].join("\n"),
      "src/cohesive.ts": [
        "export interface Shape {}",
        "export function normalize(shape: Shape) { return shape; }",
        "export function create(shape: Shape) { return normalize(shape); }",
      ].join("\n"),
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, rule, message }) => [file, rule, message]),
    [
      [
        "src/misc.ts",
        "module-cohesion",
        "src/misc.ts has 3 disconnected groups across 3 exports (max 1)",
      ],
    ]
  );
});

test("primitive-obsession counts configured primitive parameters", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "primitive-obsession": {
        level: "error",
        options: { minCount: 3 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-primitive-obsession",
    config,
    fs: memoryFileSystem({
      "src/api.ts": [
        "export function search(query: string, page: number, exact: boolean) {",
        "  return { query, page, exact };",
        "}",
        "export function wrappers(a: String, b: Number, c: Boolean) {",
        "  return { a, b, c };",
        "}",
      ].join("\n"),
    }),
  });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.rule, "primitive-obsession");
  assert.match(result.violations[0]!.message, /3 primitive parameters/);
});

test("scattered-config counts environment reads by distinct files", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "scattered-config": {
        level: "error",
        options: { minFiles: 3, ignore: ["NODE_ENV"] },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-scattered-config",
    config,
    fs: memoryFileSystem({
      "src/a.ts": "const url = process.env.API_URL;",
      "src/b.ts": "const { API_URL: url } = process.env;",
      "src/c.ts": 'const url = Deno.env.get("API_URL");',
      "src/d.ts": "const mode = process.env.NODE_ENV;",
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, rule, message }) => [file, rule, message]),
    [
      [
        "src/a.ts",
        "scattered-config",
        "Environment setting API_URL is read in 3 files (limit 2)",
      ],
    ]
  );
});

test("scattered-config ignores Deno environment method destructuring", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "scattered-config": {
        level: "error",
        options: { minFiles: 2 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-deno-env-method",
    config,
    fs: memoryFileSystem({
      "src/a.ts": "const { get } = Deno.env; get;",
      "src/b.ts": "const { get } = Deno.env; get;",
    }),
  });
  assert.deepEqual(result.violations, []);
});

test("orphan-type ignores referenced and exported types by default", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: { "orphan-type": "error" },
  });
  const result = await runRules({
    root: "/virtual-orphan-type",
    config,
    fs: memoryFileSystem({
      "src/types.ts": [
        "interface Orphan {}",
        "interface Recursive { child?: Recursive }",
        "interface Shared { label: string }",
        "export type SharedPublic = Shared;",
        "interface Unused {}",
        "export interface PublicApi {}",
        "interface ReExported {}",
        "export { ReExported as PublicType };",
        "const labels = { Orphan: 'menu' };",
        "function shadow(Unused: string) { return Unused; }",
      ].join("\n"),
    }),
  });
  assert.deepEqual(
    result.violations.map(({ rule, message }) => [rule, message]),
    [
      ["orphan-type", "Type Orphan has no references in scanned source"],
      ["orphan-type", "Type Recursive has no references in scanned source"],
      ["orphan-type", "Type Unused has no references in scanned source"],
    ]
  );
});

test("orphan-type can include unused exported API types", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "orphan-type": { level: "error", options: { includeExported: true } },
    },
  });
  const result = await runRules({
    root: "/virtual-orphan-exported",
    config,
    fs: memoryFileSystem({
      "src/types.ts": [
        "export interface PublicApi {}",
        "interface ReExported {}",
        "export { ReExported as PublicType };",
      ].join("\n"),
    }),
  });
  assert.deepEqual(
    result.violations.map(({ message }) => message),
    [
      "Type PublicApi has no references in scanned source",
      "Type ReExported has no references in scanned source",
    ]
  );
});

test("orphan-type distinguishes same-named declarations across modules", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: { "orphan-type": "error" },
  });
  const result = await runRules({
    root: "/virtual-orphan-type-symbols",
    config,
    fs: memoryFileSystem({
      "src/used.ts": "interface Token {}\nexport type PublicToken = Token;",
      "src/orphan.ts": "interface Token {}",
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, message }) => [file, message]),
    [["src/orphan.ts", "Type Token has no references in scanned source"]]
  );
});

test("unused-export reports unreferenced API symbols by resolved symbol", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: { "unused-export": "error" },
  });
  const result = await runRules({
    root: "/virtual-unused-export",
    config,
    fs: memoryFileSystem({
      "src/api.ts": [
        "export function unused() {}",
        "export function reexportOnly() {}",
        "export function used() {}",
        "export interface UnusedShape {}",
        "export const unusedValue = 1;",
        "export const labels = { used: 'label' };",
        "export function localConsumer() { return used(); }",
      ].join("\n"),
      "src/app.ts": [
        'import { used as renamed } from "./api";',
        "export const result = renamed();",
      ].join("\n"),
      "src/index.ts": 'export { reexportOnly } from "./api";',
    }),
  });
  assert.deepEqual(
    result.violations.map(({ file, rule, message }) => [file, rule, message]),
    [
      [
        "src/api.ts",
        "unused-export",
        "Exported symbol unused has no in-project references",
      ],
      [
        "src/api.ts",
        "unused-export",
        "Exported symbol UnusedShape has no in-project references",
      ],
      [
        "src/api.ts",
        "unused-export",
        "Exported symbol unusedValue has no in-project references",
      ],
      [
        "src/api.ts",
        "unused-export",
        "Exported symbol labels has no in-project references",
      ],
      [
        "src/api.ts",
        "unused-export",
        "Exported symbol localConsumer has no in-project references",
      ],
      [
        "src/app.ts",
        "unused-export",
        "Exported symbol result has no in-project references",
      ],
    ]
  );
});

test("unused-export accepts additional public entry points", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "unused-export": {
        level: "error",
        options: { entryPoints: ["src/public.ts"] },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-unused-export-entrypoint",
    config,
    fs: memoryFileSystem({
      "src/public.ts": "export function publicApi() {}",
    }),
  });
  assert.deepEqual(result.violations, []);
});

test("unused-export reports overload sets once", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "unused-export": "error",
      "module-cohesion": {
        level: "error",
        options: { minExports: 2, maxComponents: 1 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-unused-export-overloads",
    config,
    fs: memoryFileSystem({
      "src/api.ts": [
        "export function parse(value: string): string;",
        "export function parse(value: number): number;",
        "export function parse(value: string | number) { return value; }",
        "export const unrelated = 1;",
      ].join("\n"),
    }),
  });
  assert.deepEqual(
    result.violations
      .filter(({ rule }) => rule === "unused-export")
      .map(({ file, rule, message }) => [file, rule, message]),
    [
      [
        "src/api.ts",
        "unused-export",
        "Exported symbol parse has no in-project references",
      ],
      [
        "src/api.ts",
        "unused-export",
        "Exported symbol unrelated has no in-project references",
      ],
    ]
  );
  assert.match(
    result.violations.find(({ rule }) => rule === "module-cohesion")!.message,
    /across 2 exports/
  );
});

test("unused-export treats wildcard barrels as public re-exports", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: { "unused-export": "error" },
  });
  const result = await runRules({
    root: "/virtual-unused-export-star",
    config,
    fs: memoryFileSystem({
      "src/api.ts": "export function publicApi() {}",
      "src/barrel.ts": 'export * from "./api";',
    }),
  });
  assert.deepEqual(result.violations, []);
});

test("unused-export reports anonymous default function, class and expression", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: { "unused-export": "error" },
  });
  for (const declaration of [
    "export default function () {}",
    "export default class {}",
    "export default () => {};",
  ]) {
    const result = await runRules({
      root: `/virtual-unused-export-default-${declaration.length}`,
      config,
      fs: memoryFileSystem({ "src/default.ts": declaration }),
    });
    assert.deepEqual(
      result.violations.map(({ file, rule, message }) => [file, rule, message]),
      [
        [
          "src/default.ts",
          "unused-export",
          "Exported symbol default has no in-project references",
        ],
      ],
      declaration
    );
  }
});

test("symbol checks resolve aliases from nested TypeScript configs", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "orphan-type": {
        level: "error",
        options: { includeExported: true },
      },
      "unused-export": "error",
    },
  });
  const result = await runRules({
    root: "/virtual-nested-tsconfig",
    config,
    fs: memoryFileSystem({
      "packages/app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["../lib/src/*"] },
        },
      }),
      "packages/app/src/use.ts": [
        'import type { Item } from "@lib/types";',
        "type Used = Item;",
        "function consume(item: Used) { return item; }",
        "export {};",
      ].join("\n"),
      "packages/lib/src/types.ts": "export interface Item {}",
    }),
  });
  assert.deepEqual(result.violations, []);
});

test("root tsconfig takes precedence over a sibling jsconfig", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "orphan-type": {
        level: "error",
        options: { includeExported: true },
      },
      "unused-export": "error",
    },
  });
  const result = await runRules({
    root: "/virtual-root-config-precedence",
    config,
    fs: memoryFileSystem({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["src/lib/*"] },
        },
      }),
      "jsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["src/wrong/*"] },
        },
      }),
      "src/app.ts": [
        'import type { Item } from "@lib/types";',
        "type Used = Item;",
        "function consume(item: Used) { return item; }",
        "export {};",
      ].join("\n"),
      "src/lib/types.ts": "export interface Item {}",
    }),
  });
  assert.deepEqual(result.violations, []);
});

test("symbol checker cache follows the selected scan files", async () => {
  const allFiles = memoryFileSystem({
    "src/a.ts": "interface OldType {}",
    "src/b.ts": "export const value = 1;",
  });
  let selected = ["src/a.ts"];
  const fs = { ...allFiles, list: () => selected };
  const check = async (scan: string[]) =>
    runRules({
      root: "/virtual-changing-symbol-scan",
      config: resolveConfig({
        scan,
        defaultLevel: "off",
        rules: { "orphan-type": "error" },
      }),
      fs,
    });

  const first = await check(["src/a.ts"]);
  selected = ["src/b.ts"];
  const second = await check(["src/b.ts"]);
  assert.deepEqual(
    first.violations.map(({ file, rule }) => [file, rule]),
    [["src/a.ts", "orphan-type"]]
  );
  assert.deepEqual(second.violations, []);
});

test("symbol checker cache follows inherited JSON config files", async () => {
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({ extends: "../shared/base.json" }),
    "../shared/base.json": JSON.stringify({
      compilerOptions: {
        baseUrl: "../virtual-inherited-symbol-config",
        paths: { "@/*": ["src/*"] },
      },
    }),
    "src/use.ts": [
      'import type { Item } from "@/types";',
      "type Used = Item;",
      "function consume(item: Used) { return item; }",
      "export {};",
    ].join("\n"),
    "src/types.ts": "export interface Item {}",
  };
  const fs = memoryFileSystem(files);
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "orphan-type": {
        level: "error",
        options: { includeExported: true },
      },
    },
  });
  const input = { root: "/virtual-inherited-symbol-config", config, fs };
  assert.deepEqual((await runRules(input)).violations, []);
  files["../shared/base.json"] = JSON.stringify({
    compilerOptions: {
      baseUrl: "../virtual-inherited-symbol-config",
      paths: { "@/*": ["src/missing/*"] },
    },
  });
  assert.deepEqual(
    (await runRules(input)).violations.map(({ file, rule }) => [file, rule]),
    [["src/types.ts", "orphan-type"]]
  );
});

test("symbol checks use nested config for explicitly included outside files", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "orphan-type": {
        level: "error",
        options: { includeExported: true },
      },
      "unused-export": "error",
    },
  });
  const result = await runRules({
    root: "/virtual-config-external-file",
    config,
    fs: memoryFileSystem({
      "packages/app/tsconfig.json": JSON.stringify({
        files: ["../../shared/use.ts"],
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["../lib/src/*"] },
        },
      }),
      "shared/use.ts": [
        'import type { Item } from "@lib/types";',
        "type Used = Item;",
        "function consume(item: Used) { return item; }",
        "export {};",
      ].join("\n"),
      "packages/lib/src/types.ts": "export interface Item {}",
    }),
  });
  assert.deepEqual(result.violations, []);
});

test("symbol checks use nested config includes outside its directory", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "orphan-type": {
        level: "error",
        options: { includeExported: true },
      },
      "unused-export": "error",
    },
  });
  const result = await runRules({
    root: "/virtual-config-external-include",
    config,
    fs: memoryFileSystem({
      "packages/app/tsconfig.json": JSON.stringify({
        include: ["../../shared/**/*.ts"],
        compilerOptions: {
          baseUrl: ".",
          paths: { "@lib/*": ["../lib/src/*"] },
        },
      }),
      "shared/use.ts": [
        'import type { Item } from "@lib/types";',
        "type Used = Item;",
        "function consume(item: Used) { return item; }",
        "export {};",
      ].join("\n"),
      "packages/lib/src/types.ts": "export interface Item {}",
    }),
  });
  assert.deepEqual(result.violations, []);
});

test("feature-envy reports class methods dominated by one parameter", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "feature-envy": {
        level: "error",
        options: { minimumExternalAccesses: 3, minimumRatio: 2 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-feature-envy",
    config,
    fs: memoryFileSystem({
      "src/presenter.ts": [
        "class Presenter {",
        "  value = 1;",
        "  format(invoice: any) {",
        "    const { number, customer, total } = invoice;",
        "    return `${number} ${customer} ${total}`;",
        "  }",
        "  formatInput({ number, customer, total }: any) {",
        "    return `${number} ${customer} ${total}`;",
        "  }",
        "  reads(invoice: any) {",
        "    return `${invoice.number} ${invoice.customer} ${invoice.total}`;",
        "  }",
        "  aliasReads(invoice: any) {",
        "    const first = invoice;",
        "    const second = first;",
        "    return `${second.number} ${second.customer} ${second.total}`;",
        "  }",
        "  aliasDestructure(invoice: any) {",
        "    const alias = invoice;",
        "    const { number, customer, total } = alias;",
        "    return `${number} ${customer} ${total}`;",
        "  }",
        "  reassignedAlias(invoice: any) {",
        "    let alias = invoice;",
        "    alias = { number: 1, customer: 'none', total: 0 };",
        "    const copy = alias;",
        "    return `${copy.number} ${copy.customer} ${copy.total}`;",
        "  }",
        "  reassignedParameter(invoice: any) {",
        "    invoice = { number: 1, customer: 'none', total: 0 };",
        "    return `${invoice.number} ${invoice.customer} ${invoice.total}`;",
        "  }",
        "  reassignedDestructuredParameter(invoice: any, replacement: any) {",
        "    ({ invoice } = replacement);",
        "    return `${invoice.number} ${invoice.customer} ${invoice.total}`;",
        "  }",
        "  reassignedDestructuredAlias(invoice: any, replacement: any) {",
        "    let alias = invoice;",
        "    ({ alias } = replacement);",
        "    return `${alias.number} ${alias.customer} ${alias.total}`;",
        "  }",
        "  reassignedForOfAlias(invoice: any, replacement: any) {",
        "    let alias = invoice;",
        "    for (alias of [replacement]) { void alias; }",
        "    return `${alias.number} ${alias.customer} ${alias.total}`;",
        "  }",
        "  reassignedForInAlias(invoice: any, replacement: any) {",
        "    let alias = invoice;",
        "    for (alias in replacement) { void alias; }",
        "    return `${alias.number} ${alias.customer} ${alias.total}`;",
        "  }",
        "  readsBeforeAliasReassignment(invoice: any, replacement: any) {",
        "    let alias = invoice;",
        "    const before = `${alias.number} ${alias.customer} ${alias.total}`;",
        "    alias = replacement;",
        "    return before + `${alias.number} ${alias.customer} ${alias.total}`;",
        "  }",
        "  readsBeforeParameterReassignment(invoice: any, replacement: any) {",
        "    const before = `${invoice.number} ${invoice.customer} ${invoice.total}`;",
        "    invoice = replacement;",
        "    return before + `${invoice.number} ${invoice.customer} ${invoice.total}`;",
        "  }",
        "  readsInAssignmentRhs(invoice: any) {",
        "    let alias = invoice;",
        "    alias = { number: alias.number, customer: alias.customer, total: alias.total };",
        "    return this.value;",
        "  }",
        "  readsInDestructuringRhs(invoice: any) {",
        "    ({ invoice } = { invoice: { number: invoice.number, customer: invoice.customer, total: invoice.total } });",
        "    return this.value;",
        "  }",
        "  readsInForOfSource(invoice: any) {",
        "    let alias = invoice;",
        "    for (alias of [alias.number, alias.customer, alias.total]) {}",
        "    return this.value;",
        "  }",
        "  readsInForInSource(invoice: any) {",
        "    let alias = invoice;",
        "    for (alias in [alias.number, alias.customer, alias.total]) {}",
        "    return this.value;",
        "  }",
        "  bracketReads(invoice: any) {",
        '    return `${invoice["number"]} ${invoice["customer"]} ${invoice["total"]}`;',
        "  }",
        "  update(invoice: any) {",
        "    invoice.number = 1;",
        "    invoice.customer = 'none';",
        "    invoice.total = 0;",
        "  }",
        "  bracketUpdate(invoice: any) {",
        '    invoice["number"] = 1;',
        '    invoice["customer"] = "none";',
        '    invoice["total"] = 0;',
        "  }",
        "  unusedInput({ a, b, c, d }: any) { return this.value; }",
        "  unusedLocal(invoice: any) {",
        "    const { a, b, c, d } = invoice;",
        "    return this.value;",
        "  }",
        "  scopedShadow({ a, b, c }: any) {",
        "    { const a = 0; console.log(a); }",
        "    return `${a} ${b} ${c}`;",
        "  }",
        "  deleteFields(invoice: any) {",
        "    delete invoice.number;",
        "    delete invoice.customer;",
        "    delete invoice.total;",
        "  }",
        "}",
        "function outside(invoice: any) { return `${invoice.number} ${invoice.total} ${invoice.customer}`; }",
      ].join("\n"),
    }),
  });
  assert.deepEqual(
    result.violations.map(({ rule, message }) => [rule, message]),
    [
      [
        "feature-envy",
        "format reads 3 properties from parameter invoice and 0 from this",
      ],
      [
        "feature-envy",
        "formatInput reads 3 properties from destructured parameter 1 and 0 from this",
      ],
      [
        "feature-envy",
        "reads reads 3 properties from parameter invoice and 0 from this",
      ],
      [
        "feature-envy",
        "aliasReads reads 3 properties from parameter invoice and 0 from this",
      ],
      [
        "feature-envy",
        "aliasDestructure reads 3 properties from parameter invoice and 0 from this",
      ],
      [
        "feature-envy",
        "readsBeforeAliasReassignment reads 3 properties from parameter invoice and 0 from this",
      ],
      [
        "feature-envy",
        "readsBeforeParameterReassignment reads 3 properties from parameter invoice and 0 from this",
      ],
      [
        "feature-envy",
        "readsInAssignmentRhs reads 3 properties from parameter invoice and 1 from this",
      ],
      [
        "feature-envy",
        "readsInDestructuringRhs reads 3 properties from parameter invoice and 1 from this",
      ],
      [
        "feature-envy",
        "readsInForOfSource reads 3 properties from parameter invoice and 1 from this",
      ],
      [
        "feature-envy",
        "readsInForInSource reads 3 properties from parameter invoice and 1 from this",
      ],
      [
        "feature-envy",
        "bracketReads reads 3 properties from parameter invoice and 0 from this",
      ],
      [
        "feature-envy",
        "scopedShadow reads 3 properties from destructured parameter 1 and 0 from this",
      ],
    ]
  );
  assert.deepEqual(
    result.violations.map((violation) => violation.metrics?.externalAccesses),
    Array.from({ length: 13 }, () => ({ value: 3, worsening: "higher" }))
  );
});

test("shared-mutable-state flags exported mutable bindings and collections", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: { "shared-mutable-state": "error" },
  });
  const result = await runRules({
    root: "/virtual-shared-state",
    config,
    fs: memoryFileSystem({
      "src/state.ts": [
        "export let counter = 0;",
        "export const registry = {};",
        "export const ids = [];",
        "export const label = 'ready';",
        "let listedCounter = 0;",
        "export { listedCounter as sharedCounter };",
        "const { nested } = { nested: {} };",
        "export { nested as sharedNested };",
      ].join("\n"),
      "src/default-alias.ts": "const cache = new Map();\nexport default cache;",
      "src/default-object.ts": "export default { mutable: true };",
    }),
  });
  assert.equal(result.violations.length, 7);
  assert.deepEqual(
    result.violations.map((violation) => violation.message).sort(),
    [
      "Exported binding counter may expose shared mutable state",
      "Exported binding registry may expose shared mutable state",
      "Exported binding ids may expose shared mutable state",
      "Exported binding listedCounter may expose shared mutable state",
      "Exported binding nested may expose shared mutable state",
      "Default export may expose shared mutable state",
      "Default export may expose shared mutable state",
    ].sort()
  );
});

test("same-line anonymous functions get distinct baseline identities", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cyclomatic-complexity": { level: "error", options: { max: 1 } },
    },
  });
  const result = await runRules({
    root: "/virtual-structural-identities",
    config,
    fs: memoryFileSystem({
      "src/anonymous.ts":
        "const first = () => (true && false) ? 1 : 2; const second = () => (true || false) ? 1 : 2;",
    }),
  });
  assert.equal(result.violations.length, 2);
  assert.equal(
    new Set(result.violations.map((violation) => violation.identity)).size,
    2
  );
});

test("function metric identities survive unrelated syntax before them", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cyclomatic-complexity": { level: "error", options: { max: 1 } },
    },
  });
  const analyze = (text: string) =>
    runRules({
      root: "/virtual-stable-function-identity",
      config,
      fs: memoryFileSystem({ "src/a.ts": text }),
    });
  const before = await analyze(
    "function foo() { if (true) return 1; return 0; }"
  );
  const after = await analyze(
    "const marker = 0;\nfunction foo() { if (true) return 1; return 0; }"
  );
  assert.equal(before.violations[0]?.metrics?.complexity?.value, 2);
  assert.equal(after.violations[0]?.identity, before.violations[0]?.identity);
});

test("nested named functions in callbacks keep stable worsening identities", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "cyclomatic-complexity": { level: "error", options: { max: 1 } },
    },
  });
  const analyze = (
    firstComplexity: number,
    secondComplexity: number,
    prependHelperComplexity = 0,
    addLocalMarker = false
  ) =>
    runRules({
      root: "/virtual-callback-function-identities",
      config,
      fs: memoryFileSystem({
        "src/callbacks.ts": `function run() {
  ${
    prependHelperComplexity > 0
      ? `items.forEach(() => {
    function helper() {
      ${Array.from({ length: prependHelperComplexity - 1 }, () => "if (true) return 1;").join("\n      ")}
      return 0;
    }
  });`
      : ""
  }
  items.forEach(() => {
    ${addLocalMarker ? "const marker = 0;" : ""}
    function helper() {
      ${Array.from({ length: firstComplexity - 1 }, () => "if (true) return 1;").join("\n      ")}
      return 0;
    }
    helper();
  });
  items.forEach(() => {
    function helper() {
      ${Array.from({ length: secondComplexity - 1 }, () => "if (true) return 1;").join("\n      ")}
      return 0;
    }
    helper();
  });
}`,
      }),
    });
  const before = await analyze(2, 3);
  const reordered = await analyze(3, 2, 1, true);
  const worsened = await analyze(3, 3, 1, true);
  const inserted = await analyze(2, 3, 4);
  const identities = before.violations.map((violation) => violation.identity);
  assert.equal(new Set(identities).size, 1);
  assert.deepEqual(
    reordered.violations.map((violation) => violation.identity),
    identities
  );

  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-identity-"));
  try {
    writeBaseline(
      root,
      "baseline.json",
      before.violations,
      undefined,
      "worsening"
    );
    const baseline = readBaseline(root, "baseline.json");
    const reorderedComparison = compareToBaseline(
      reordered.violations,
      baseline
    );
    assert.equal(reorderedComparison.fresh.length, 0);
    assert.equal(reorderedComparison.debt, 2);

    const worsenedComparison = compareToBaseline(worsened.violations, baseline);
    assert.equal(worsenedComparison.fresh.length, 1);
    assert.equal(worsenedComparison.debt, 1);

    const insertedComparison = compareToBaseline(inserted.violations, baseline);
    assert.equal(insertedComparison.fresh.length, 1);
    assert.equal(insertedComparison.debt, 2);
    assert.equal(insertedComparison.fresh[0]?.metrics?.complexity?.value, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
