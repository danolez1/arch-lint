import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfigs, resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import { matchesPattern } from "../../src/arch/paths";
import { patternRule } from "../../src/arch/rules/util";
import { runRules } from "../../src/arch/run";

const demo = patternRule({
  id: "no-demo",
  aliases: ["no-demo-old"],
  description: "demo",
  defaultLayer: "backend",
  pattern: /\bdemo\(/,
  message: "no demo",
});

const files = {
  "services/a/src/x.ts": "demo(1);\n// demo(2)\n",
  "apps/web/src/y.ts": "demo(3);\n",
  "services/a/src/legacy.ts": "demo(4);\n",
  "services/a/tests/z.ts": "demo(5);\n",
  "services/a/src/types.d.ts": "demo(6);\n",
};

async function run(config: Parameters<typeof mergeConfigs>[1]) {
  const resolved = resolveConfig(
    mergeConfigs({ layers: { backend: ["services/"] } }, config)
  );
  return runRules({
    root: "/v",
    config: resolved,
    fs: memoryFileSystem(files),
    rules: [demo],
  });
}

test("layer limits a rule, comments and tests and .d.ts are skipped", async () => {
  const { violations, scanned } = await run({});
  assert.deepEqual(
    violations.map((v) => `${v.file}:${v.line}`),
    ["services/a/src/legacy.ts:1", "services/a/src/x.ts:1"]
  );
  assert.equal(scanned, 3);
});

test("config can move a rule to another layer, exempt files and use aliases", async () => {
  const moved = await run({
    layers: { web: ["apps/"] },
    rules: { "no-demo-old": { layer: "web" } },
  });
  assert.deepEqual(
    moved.violations.map((v) => v.file),
    ["apps/web/src/y.ts"]
  );
  const exempt = await run({
    rules: { "no-demo": { exempt: { files: ["services/a/src/x.ts"] } } },
  });
  assert.deepEqual(
    exempt.violations.map((v) => v.file),
    ["services/a/src/legacy.ts"]
  );
  const off = await run({ rules: { "no-demo": "off" } });
  assert.equal(off.violations.length, 0);
});

test("an undefined layer matches everything", async () => {
  const resolved = resolveConfig({});
  const { violations } = await runRules({
    root: "/v",
    config: resolved,
    fs: memoryFileSystem(files),
    rules: [demo],
  });
  assert.equal(violations.length, 3);
});

test("glob matching", () => {
  assert.ok(matchesPattern("a/b/c.ts", "a/"));
  assert.ok(matchesPattern("a/b/c.ts", "**/c.ts"));
  assert.ok(matchesPattern("c.ts", "**/c.ts"));
  assert.ok(matchesPattern("a/b/c.ts", "a/*/c.ts"));
  assert.ok(!matchesPattern("a/b/d/c.ts", "a/*/c.ts"));
  assert.ok(matchesPattern("a/b/x.test.ts", "**/*.test.*"));
  assert.ok(matchesPattern("services/x/src/a.ts", "services/*/src/**"));
  assert.ok(matchesPattern("a/b.tsx", "a/*.{ts,tsx}"));
});

test("config defaultLevel off runs only the listed rules", async () => {
  const other = patternRule({
    id: "no-other",
    description: "other",
    pattern: /\bdemo\(/,
    message: "no",
  });
  const resolved = resolveConfig({
    defaultLevel: "off",
    rules: { "no-demo": "error" },
  });
  const { violations } = await runRules({
    root: "/v",
    config: resolved,
    fs: memoryFileSystem(files),
    rules: [demo, other],
  });
  assert.ok(violations.length > 0);
  assert.ok(violations.every((v) => v.rule === "no-demo"));
});

test("an empty rule filter means every rule", async () => {
  const resolved = resolveConfig({});
  const { violations } = await runRules({
    root: "/v",
    config: resolved,
    fs: memoryFileSystem(files),
    rules: [demo],
    only: [],
  });
  assert.equal(violations.length, 3);
});

import { loadConfig } from "../../src/arch/config";
import { buildSource, importsOf } from "../../src/arch/source";

test("importsOf pairs each import with its own from clause and line", () => {
  const text =
    'export const x = 1\nexport function f() {}\nimport axios from "axios";\nimport {\n  a,\n  b,\n} from "./m";\nexport * from "./n";\n';
  const refs = importsOf(buildSource("a.ts", text));
  assert.deepEqual(
    refs.map((r) => [r.source, r.line]),
    [
      ["axios", 3],
      ["./m", 4],
      ["./n", 8],
    ]
  );
});

test("an explicit config path that does not exist is an error", () => {
  assert.throws(
    () => loadConfig("/nowhere", "missing.json"),
    /Config file not found/
  );
});

test("exempt.files accepts globs as well as exact paths", async () => {
  const exempt = await run({
    rules: { "no-demo": { exempt: { files: ["services/a/src/leg*.ts"] } } },
  });
  assert.deepEqual(
    exempt.violations.map((v) => v.file),
    ["services/a/src/x.ts"]
  );
});
