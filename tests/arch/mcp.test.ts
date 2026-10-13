import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(new URL("../../src/arch/mcp.ts", import.meta.url));

test("MCP server initializes, lists tools, and returns resolved graph data", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/a.ts"), 'import "./b";');
    writeFileSync(path.join(root, "src/b.ts"), "export {};\n");
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "archlint_graph", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "archlint_dependencies",
          arguments: { file: "src/a.ts" },
        },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "archlint_metrics", arguments: {} },
      },
    ]
      .map((request) => JSON.stringify(request))
      .join("\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      { encoding: "utf8", input, timeout: 15_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(responses[0].result.serverInfo.name, "arch-lint");
    assert.ok(
      responses[1].result.tools.some(
        (tool: { name: string }) => tool.name === "archlint_graph"
      )
    );
    assert.deepEqual(responses[2].result.structuredContent.edges, [
      {
        from: "src/a.ts",
        to: "src/b.ts",
        line: 1,
        typeOnly: false,
        sideEffect: true,
      },
    ]);
    assert.deepEqual(responses[3].result.structuredContent, {
      file: "src/a.ts",
      incoming: [],
      outgoing: ["src/b.ts"],
    });
    assert.equal(responses[4].result.structuredContent.files.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP architecture metrics include layers declared in ADR files", () => {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "arch-lint-mcp-adr-metrics-")
  );
  try {
    mkdirSync(path.join(root, "src/app"), { recursive: true });
    mkdirSync(path.join(root, "src/db"), { recursive: true });
    mkdirSync(path.join(root, "docs/adr"), { recursive: true });
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({ scan: ["src"], adrDir: "docs/adr", defaultLevel: "off" })
    );
    writeFileSync(path.join(root, "src/app/page.ts"), 'import "../db/query";');
    writeFileSync(path.join(root, "src/db/query.ts"), "export {};\n");
    writeFileSync(
      path.join(root, "docs/adr/001-layers.md"),
      ["```archlint", "layer app = src/app/", "layer db = src/db/", "```"].join(
        "\n"
      )
    );
    const input = ["get_architecture", "archlint_metrics"]
      .map((name, index) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: index + 1,
          method: "tools/call",
          params: { name, arguments: {} },
        })
      )
      .join("\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      { encoding: "utf8", input, timeout: 20_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const architecture = responses[0].result.structuredContent;
    for (const metrics of [
      architecture.metrics,
      responses[1].result.structuredContent,
    ]) {
      assert.deepEqual(
        metrics.layers.map(({ layer }: { layer: string }) => layer),
        ["app", "db"]
      );
      assert.equal(metrics.layers[0].Ce, 1);
      assert.equal(metrics.layers[1].Ca, 1);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP dependency lookup rejects paths outside the project", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-")).replace(
    /\\/g,
    "/"
  );
  try {
    mkdirSync(path.join(root, "src"));
    const input = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "archlint_dependencies",
        arguments: { file: "../../outside.ts" },
      },
    });
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      { encoding: "utf8", input, timeout: 15_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    assert.match(response.result.content[0].text, /inside the project root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP exposes change, file, callgraph, dependency, and decision tools", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-tools-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        rules: { "unused-export": "error" },
      })
    );
    writeFileSync(
      path.join(root, "src/a.ts"),
      [
        'import { unused } from "./b";',
        "export interface Service { run(): void }",
        "export const invoke = () => unused();",
        "export class Example { constructor() {} method() {} }",
        "export const assigned = function named() {};",
      ].join("\n")
    );
    writeFileSync(
      path.join(root, "src/b.ts"),
      "export function unused() { return 1; }\nexport function orphan() { return 2; }\n"
    );
    const requests = [
      { id: 1, method: "tools/list" },
      {
        id: 2,
        method: "tools/call",
        params: { name: "analyze_file", arguments: { file: "src/a.ts" } },
      },
      {
        id: 3,
        method: "tools/call",
        params: {
          name: "analyze_change",
          arguments: { files: ["src/b.ts"] },
        },
      },
      {
        id: 4,
        method: "tools/call",
        params: { name: "get_callgraph", arguments: { file: "src/a.ts" } },
      },
      {
        id: 5,
        method: "tools/call",
        params: { name: "get_architecture", arguments: {} },
      },
      {
        id: 6,
        method: "tools/call",
        params: {
          name: "get_dependencies",
          arguments: { file: "src/a.ts", direction: "outgoing" },
        },
      },
    ].map((request) => ({ jsonrpc: "2.0", ...request }));
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      {
        encoding: "utf8",
        input: requests.map((request) => JSON.stringify(request)).join("\n"),
        timeout: 20_000,
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const responses = child.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const names = responses[0].result.tools.map(
      (tool: { name: string }) => tool.name
    );
    for (const name of [
      "check_violations",
      "analyze_file",
      "analyze_change",
      "get_dependencies",
      "get_architecture",
      "get_callgraph",
    ])
      assert.ok(names.includes(name), name);
    const file = responses[1].result.structuredContent;
    assert.equal(file.file, "src/a.ts");
    assert.ok(
      file.declarations.some(({ name }: { name: string }) => name === "Service")
    );
    assert.ok(
      file.exports.some(({ name }: { name: string }) => name === "invoke")
    );
    const functionNames = file.functions.map(
      ({ name }: { name: string }) => name
    );
    assert.ok(functionNames.includes("named"));
    assert.ok(functionNames.includes("Example.constructor"));
    assert.ok(functionNames.includes("Example.method"));
    const change = responses[2].result.structuredContent;
    assert.ok(change.affectedFiles.includes("src/a.ts"));
    assert.ok(
      change.findings.some(
        ({ rule }: { rule: string }) => rule === "unused-export"
      )
    );
    const finding = change.findings.find(
      ({ rule, location }: { rule: string; location: { file: string } }) =>
        rule === "unused-export" && location.file === "src/b.ts"
    );
    assert.ok(finding);
    assert.equal(finding.severity, "ERROR");
    assert.equal(finding.human_in_loop, true);
    assert.equal(finding.requires_delta, true);
    assert.equal(finding.location.file, "src/b.ts");
    assert.ok(
      responses[3].result.structuredContent.calls.some(
        ({ to }: { to: string }) => to.includes("unused")
      )
    );
    assert.ok(responses[4].result.structuredContent.metrics);
    assert.deepEqual(responses[5].result.structuredContent.outgoing, [
      "src/b.ts",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP change analysis keeps importers affected when a source file is deleted", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-deleted-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "src/deleted.ts"),
      "export function oldApi() {}\n"
    );
    writeFileSync(
      path.join(root, "src/consumer.ts"),
      'import { oldApi } from "./deleted";\nexport function useApi() { oldApi(); }\n'
    );
    spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    spawnSync("git", ["add", "src"], { cwd: root, encoding: "utf8" });
    const committed = spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(committed.status, 0, committed.stderr);
    rmSync(path.join(root, "src/deleted.ts"));

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      {
        encoding: "utf8",
        input: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "analyze_change",
            arguments: { files: ["src/deleted.ts"] },
          },
        }),
        timeout: 20_000,
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    const change = response.result.structuredContent;
    assert.deepEqual(change.changedFiles, ["src/deleted.ts"]);
    assert.ok(change.affectedFiles.includes("src/deleted.ts"));
    assert.ok(change.affectedFiles.includes("src/consumer.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP change analysis includes both paths for a renamed source file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-rename-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "src/old.ts"),
      "export function oldApi() {}\n"
    );
    writeFileSync(
      path.join(root, "src/consumer.ts"),
      'import { oldApi } from "./old";\nexport function useApi() { oldApi(); }\n'
    );
    const initialized = spawnSync("git", ["init", "-q"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    const staged = spawnSync("git", ["add", "src"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(staged.status, 0, staged.stderr);
    const committed = spawnSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: root, encoding: "utf8" }
    );
    assert.equal(committed.status, 0, committed.stderr);
    const renamed = spawnSync("git", ["mv", "src/old.ts", "src/new.ts"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(renamed.status, 0, renamed.stderr);

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      {
        encoding: "utf8",
        input: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "analyze_change", arguments: {} },
        }),
        timeout: 20_000,
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    const change = response.result.structuredContent;
    assert.deepEqual(change.changedFiles, ["src/new.ts", "src/old.ts"]);
    assert.ok(change.affectedFiles.includes("src/consumer.ts"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP file-filtered scans label project-wide counts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-counts-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        rules: { "no-any": "error" },
      })
    );
    writeFileSync(path.join(root, "src/a.ts"), "export const a: any = null;\n");
    writeFileSync(path.join(root, "src/b.ts"), "export const b: any = null;\n");

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      {
        encoding: "utf8",
        input: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "archlint_scan",
            arguments: { file: "src/a.ts" },
          },
        }),
        timeout: 20_000,
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    const scan = response.result.structuredContent;
    assert.equal(scan.count_scope, "project");
    assert.equal(scan.new, 2);
    assert.equal(scan.findings.length, 1);
    assert.equal(scan.findings[0]?.file, "src/a.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP scan counts JavaScript analyzed by project architecture rules", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-js-scan-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        rules: { "unused-export": "error" },
      })
    );
    writeFileSync(path.join(root, "src/a.js"), "export function unused() {}\n");

    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      {
        encoding: "utf8",
        input: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "archlint_scan", arguments: {} },
        }),
        timeout: 20_000,
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    const scan = response.result.structuredContent;
    assert.equal(scan.scanned, 1);
    assert.equal(scan.findings.length, 1);
    assert.equal(scan.findings[0]?.file, "src/a.js");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP scan keeps graph rules off when graph analysis is not requested", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({ scan: ["src"], defaultLevel: "error" })
    );
    writeFileSync(path.join(root, "src/a.ts"), 'import type { B } from "./b";');
    writeFileSync(path.join(root, "src/b.ts"), 'import type { A } from "./a";');
    const input = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "archlint_scan", arguments: { graph: false } },
    });
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      { encoding: "utf8", input, timeout: 15_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    assert.deepEqual(
      response.result.structuredContent.findings.map(
        ({ rule }: { rule: string }) => rule
      ),
      []
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP checks baseline compatibility before scanning", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-baseline-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({
        scan: ["src"],
        baselineMode: "worsening",
        defaultLevel: "off",
        rules: {
          "hub-module": {
            level: "error",
            options: { minFanIn: 0 },
          },
        },
      })
    );
    writeFileSync(
      path.join(root, "arch-lint.baseline.json"),
      JSON.stringify({ version: 2, findings: ["populated"], legacy: {} })
    );
    writeFileSync(path.join(root, "src/a.ts"), "export {};\n");
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      {
        encoding: "utf8",
        input: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "archlint_scan", arguments: { graph: true } },
        }),
        timeout: 15_000,
      }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    assert.match(response.result.content[0].text, /refreshed baseline/);
    assert.doesNotMatch(response.result.content[0].text, /minFanIn/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP scan preserves an explicit graph rule selection", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-"));
  try {
    mkdirSync(path.join(root, "src/x"), { recursive: true });
    mkdirSync(path.join(root, "src/y"), { recursive: true });
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        layers: { x: ["src/x/"], y: ["src/y/"] },
        allowedDependencies: { x: [], y: ["x"] },
      })
    );
    writeFileSync(path.join(root, "src/x/a.ts"), 'import "../y/b";');
    writeFileSync(path.join(root, "src/y/b.ts"), 'import "../x/a";');
    const input = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "archlint_scan",
        arguments: { graph: true, rules: ["circular-dependency"] },
      },
    });
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      { encoding: "utf8", input, timeout: 15_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    assert.deepEqual(
      [
        ...new Set(
          response.result.structuredContent.findings.map(
            ({ rule }: { rule: string }) => rule
          )
        ),
      ],
      ["circular-dependency"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("MCP scan enables the aggregate graph rule when explicitly selected", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-mcp-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({ scan: ["src"], defaultLevel: "off" })
    );
    writeFileSync(path.join(root, "src/a.ts"), 'import "./b";');
    writeFileSync(path.join(root, "src/b.ts"), 'import "./a";');
    const input = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "archlint_scan",
        arguments: { graph: true, rules: ["architecture-graph"] },
      },
    });
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", entry, "--root", root],
      { encoding: "utf8", input, timeout: 15_000 }
    );
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout.trim());
    assert.deepEqual(
      [
        ...new Set(
          response.result.structuredContent.findings.map(
            ({ rule }: { rule: string }) => rule
          )
        ),
      ],
      ["circular-dependency"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
