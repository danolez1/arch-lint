import { Linter } from "eslint";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import plugin from "../src/eslint/plugin.mjs";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const archEntry = new URL("../src/arch/index.ts", import.meta.url);

test("ESLint adapter reports architecture findings at their source line", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-eslint-"));
  try {
    mkdirSync(path.join(root, "src"));
    writeFileSync(
      path.join(root, "src/a.ts"),
      'function fail() { throw new Error("bad"); }\n'
    );
    writeFileSync(
      path.join(root, "arch-lint.config.json"),
      JSON.stringify({ rules: { "no-raw-throw": "error" } })
    );
    const scan = spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        archEntry.pathname,
        "--root",
        root,
        "--format",
        "json",
      ],
      { cwd: root, encoding: "utf8" }
    );
    assert.match(scan.stdout, /no-raw-throw/);
    const linter = new Linter({ configType: "flat", cwd: root });
    const messages = linter.verify(
      'function fail() { throw new Error("bad"); }\n',
      {
        files: ["**/*.ts"],
        plugins: { archlint: plugin },
        rules: { "archlint/architecture": "error" },
        settings: { archLint: { root } },
      },
      path.join(root, "src/a.ts")
    );
    assert.ok(
      messages.some((message) => message.message.includes("no-raw-throw")),
      JSON.stringify(messages)
    );
    assert.equal(
      messages.find((message) => message.message.includes("no-raw-throw"))
        ?.line,
      1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ESLint adapter tolerates watcher failures while bounding project roots", async () => {
  const parent = mkdtempSync(path.join(os.tmpdir(), "arch-lint-eslint-roots-"));
  try {
    const missingRoot = path.join(parent, "missing");
    const missingLinter = new Linter({ configType: "flat", cwd: missingRoot });
    const missingMessages = missingLinter.verify(
      "export {};\n",
      {
        files: ["**/*.ts"],
        plugins: { archlint: plugin },
        rules: { "archlint/architecture": "error" },
        settings: { archLint: { root: missingRoot } },
      },
      path.join(missingRoot, "src/a.ts")
    );
    assert.ok(
      missingMessages.some((message) =>
        message.message.includes("scan failed")
      ),
      JSON.stringify(missingMessages)
    );

    for (let index = 0; index < 16; index++) {
      const root = path.join(parent, String(index));
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src/a.ts"), "export {};\n");
      const linter = new Linter({ configType: "flat", cwd: root });
      const messages = linter.verify(
        "export {};\n",
        {
          files: ["**/*.ts"],
          plugins: { archlint: plugin },
          rules: { "archlint/architecture": "error" },
          settings: { archLint: { root } },
        },
        path.join(root, "src/a.ts")
      );
      assert.ok(
        !messages.some((message) => message.message.includes("scan failed")),
        JSON.stringify(messages)
      );
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});
