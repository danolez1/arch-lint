import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  levelFor,
  loadConfig,
  resolveConfig,
  settingsFor,
} from "../../src/arch/config";
import { matchesAny } from "../../src/arch/paths";
import { findRule } from "../../src/arch/registry";

const cases = [
  ["nestjs", "src/users/users.controller.ts"],
  ["nextjs", "src/app/account/page.tsx"],
  ["express", "src/routes/users.ts"],
  ["react", "src/App.tsx"],
  ["vue", "src/views/Home.ts"],
  ["angular", "src/users/users.component.ts"],
] as const;

test("framework presets enable cycle checks and protect framework entry points", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-presets-"));
  try {
    for (const [preset, entryPoint] of cases) {
      writeFileSync(
        path.join(root, `arch-lint-${preset}.json`),
        JSON.stringify({ extends: [`preset:${preset}`] })
      );
      const config = resolveConfig(
        loadConfig(root, `arch-lint-${preset}.json`)
      );
      const unusedExport = findRule("unused-export");
      const circular = findRule("circular-dependency");
      assert.ok(unusedExport);
      assert.ok(circular);
      assert.equal(levelFor(config, circular), "error", preset);
      assert.equal(levelFor(config, unusedExport), "error", preset);
      const patterns = settingsFor(config, unusedExport).options?.entryPoints;
      assert.ok(Array.isArray(patterns), preset);
      assert.ok(
        matchesAny(entryPoint, patterns as string[]),
        `${preset}: ${entryPoint}`
      );
      if (preset === "vue")
        assert.equal(
          matchesAny("src/views/Home.vue", patterns as string[]),
          false
        );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("baseline mode defaults to identity and validates configured values", () => {
  assert.equal(resolveConfig({}).baselineMode, "identity");
  assert.equal(
    resolveConfig({ baselineMode: "worsening" }).baselineMode,
    "worsening"
  );
  assert.throws(
    () => resolveConfig({ baselineMode: "unknown" as "identity" }),
    /baselineMode must be/
  );
});
