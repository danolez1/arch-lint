import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import {
  architectureGraphRuleIds,
  architectureMetrics,
  buildProjectGraph,
  coChangeFindingsFromLog,
  coChangeRevision,
  graphEnclosingPackageManifestFiles,
} from "../../src/arch/graph";
import { runRules } from "../../src/arch/run";

function graphFor(files: Record<string, string>, root = "/virtual") {
  const fs = memoryFileSystem(files);
  const config = resolveConfig({});
  return buildProjectGraph({
    root,
    config,
    options: {},
    inLayer: () => true,
    hasLayer: (layer) => config.layers[layer] !== undefined,
    files: [],
    listFiles: (extensions) =>
      fs
        .list()
        .filter(
          (file) =>
            !extensions ||
            extensions.some((extension) => file.endsWith(extension))
        ),
    listFilesOutsideScan: () => fs.list(),
    read: fs.read,
  });
}

test("graph resolves static, type-only, side-effect, re-export, CommonJS and dynamic imports", () => {
  const graph = graphFor({
    "src/a.ts": [
      'import "./side";',
      'import type { T } from "./types";',
      'import { type InlineT } from "./inline-types";',
      'import type Alias = require("./import-equals-type");',
      'type Imported = import("./import-type").Value;',
      'export { value } from "./re-export";',
      'export { type InlineValue } from "./inline-re-export";',
      'const cjs = require("./common");',
      'const lazy = import("./lazy");',
    ].join("\n"),
    "src/side.ts": "",
    "src/types.ts": "",
    "src/inline-types.ts": "",
    "src/import-equals-type.ts": "",
    "src/import-type.ts": "",
    "src/re-export.ts": "",
    "src/inline-re-export.ts": "",
    "src/common.ts": "",
    "src/lazy.ts": "",
  });
  assert.deepEqual(
    graph.edges.map(({ to, typeOnly }) => [to, typeOnly]),
    [
      ["src/side.ts", false],
      ["src/types.ts", true],
      ["src/inline-types.ts", true],
      ["src/import-equals-type.ts", true],
      ["src/import-type.ts", true],
      ["src/re-export.ts", false],
      ["src/inline-re-export.ts", true],
      ["src/common.ts", false],
      ["src/lazy.ts", false],
    ]
  );
});

test("graph resolves tsconfig path aliases and JavaScript extension substitution", () => {
  const graph = graphFor({
    "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json" }),
    "tsconfig.base.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
    }),
    "src/a.ts": 'import { value } from "@/b.js";',
    "src/b.ts": "export const value = 1;",
  });
  assert.deepEqual(
    graph.edges.map(({ to }) => to),
    ["src/b.ts"]
  );
});

test("graph resolves the most specific matching tsconfig alias", () => {
  const graph = graphFor({
    "tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "@/*": ["src/general/*"],
          "@/feature/*": ["src/feature/*"],
        },
      },
    }),
    "src/app.ts": 'import "@/feature/model";',
    "src/general/feature/model.ts": "export {};",
    "src/feature/model.ts": "export {};",
  });
  assert.deepEqual(
    graph.edges.map(({ to }) => to),
    ["src/feature/model.ts"]
  );
});

test("graph resolves path aliases from nested tsconfig files", () => {
  const graph = graphFor({
    "packages/app/tsconfig.json": JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: { "@lib/*": ["../lib/src/*"] },
      },
      include: ["src/**/*.ts"],
    }),
    "packages/app/src/main.ts": 'import "@lib/model";',
    "packages/lib/src/model.ts": "export {};",
  });
  assert.deepEqual(
    graph.edges.map(({ from, to }) => [from, to]),
    [["packages/app/src/main.ts", "packages/lib/src/model.ts"]]
  );
});

test("workspace exports choose the most specific subpath pattern", () => {
  const graph = graphFor({
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: {
        "./*": "./src/generic/*.ts",
        "./features/*": "./src/features/*.ts",
      },
    }),
    "src/app.ts": 'import "@sample/lib/features/x";',
    "packages/lib/src/generic/features/x.ts": "export {};",
    "packages/lib/src/features/x.ts": "export {};",
  });
  assert.deepEqual(
    graph.edges.map(({ to }) => to),
    ["packages/lib/src/features/x.ts"]
  );
});

test("workspace exports prefer ESM conditions over require targets", () => {
  const graph = graphFor({
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: {
        ".": {
          require: "./cjs/index.cjs",
          import: "./src/index.ts",
        },
      },
    }),
    "src/app.ts": 'import "@sample/lib";',
    "packages/lib/cjs/index.cjs": "module.exports = {};",
    "packages/lib/src/index.ts": "export {};",
  });
  assert.deepEqual(
    graph.edges.map(({ to }) => to),
    ["packages/lib/src/index.ts"]
  );
});

test("ESM imports do not fall back to require-only workspace exports", () => {
  const graph = graphFor({
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: { ".": { require: "./cjs/index.cjs" } },
    }),
    "src/app.mts": 'import "@sample/lib";',
    "packages/lib/cjs/index.cjs": "module.exports = {};",
  });
  assert.deepEqual(graph.edges, []);
});

test("CommonJS workspace imports prefer require export conditions", () => {
  const graph = graphFor({
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: {
        ".": {
          import: "./src/index.ts",
          require: "./cjs/index.cjs",
        },
      },
    }),
    "src/app.cjs": 'require("@sample/lib");',
    "packages/lib/cjs/index.cjs": "module.exports = {};",
    "packages/lib/src/index.ts": "export {};",
  });
  assert.deepEqual(
    graph.edges.map(({ to }) => to),
    ["packages/lib/cjs/index.cjs"]
  );
});

test("NodeNext static imports follow the containing file module format", () => {
  const graph = graphFor({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
    }),
    "package.json": JSON.stringify({ type: "module" }),
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: {
        ".": {
          import: "./esm/index.mjs",
          require: "./cjs/index.cjs",
        },
      },
    }),
    "src/app.cts": 'import "@sample/lib";',
    "src/commonjs/package.json": JSON.stringify({ type: "commonjs" }),
    "src/commonjs/app.ts": 'import "@sample/lib";',
    "src/esm/app.ts": 'import "@sample/lib";',
    "packages/lib/esm/index.mjs": "export {};",
    "packages/lib/cjs/index.cjs": "module.exports = {};",
  });
  assert.deepEqual(
    graph.edges.map(({ from, to }) => [from, to]),
    [
      ["src/app.cts", "packages/lib/cjs/index.cjs"],
      ["src/commonjs/app.ts", "packages/lib/cjs/index.cjs"],
      ["src/esm/app.ts", "packages/lib/esm/index.mjs"],
    ]
  );
});

test("graph edges refresh when a package changes its NodeNext module type", () => {
  const shared = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
    }),
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: {
        ".": {
          import: "./esm/index.mjs",
          require: "./cjs/index.cjs",
        },
      },
    }),
    "src/app.ts": 'import "@sample/lib";',
    "packages/lib/esm/index.mjs": "export {};",
    "packages/lib/cjs/index.cjs": "module.exports = {};",
  };
  const esm = graphFor({
    ...shared,
    "package.json": JSON.stringify({ type: "module" }),
  });
  assert.deepEqual(
    esm.edges.map(({ to }) => to),
    ["packages/lib/esm/index.mjs"]
  );

  const commonjs = graphFor({
    ...shared,
    "package.json": JSON.stringify({ type: "commonjs" }),
  });
  assert.deepEqual(
    commonjs.edges.map(({ to }) => to),
    ["packages/lib/cjs/index.cjs"]
  );
});

test("graph edges refresh when an enclosing package changes its NodeNext module type", () => {
  const shared = {
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
    }),
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: {
        ".": {
          import: "./esm/index.mjs",
          require: "./cjs/index.cjs",
        },
      },
    }),
    "src/app.ts": 'import "@sample/lib";',
    "packages/lib/esm/index.mjs": "export {};",
    "packages/lib/cjs/index.cjs": "module.exports = {};",
  };
  const esm = graphFor(
    { ...shared, "../package.json": JSON.stringify({ type: "module" }) },
    "/workspace/project"
  );
  assert.deepEqual(
    esm.edges.map(({ to }) => to),
    ["packages/lib/esm/index.mjs"]
  );

  const commonjs = graphFor(
    { ...shared, "../package.json": JSON.stringify({ type: "commonjs" }) },
    "/workspace/project"
  );
  assert.deepEqual(
    commonjs.edges.map(({ to }) => to),
    ["packages/lib/cjs/index.cjs"]
  );
});

test("graph finding cache and watch inputs include enclosing package manifests", async () => {
  const files: Record<string, string> = {
    "../package.json": JSON.stringify({ type: "module" }),
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
    }),
    "packages/lib/package.json": JSON.stringify({
      name: "@sample/lib",
      exports: {
        ".": {
          import: "./esm/index.mjs",
          require: "./cjs/index.cjs",
        },
      },
    }),
    "src/app.ts": 'import "@sample/lib";',
    "packages/lib/esm/index.mjs": "export {};",
    "packages/lib/cjs/index.cjs": "module.exports = {};",
  };
  const fs = memoryFileSystem(files);
  const config = resolveConfig({
    scan: ["src"],
    layers: { app: ["src/"], commonjs: ["packages/lib/cjs/"] },
    allowedDependencies: { app: [] },
    rules: { "layer-boundary": "error" },
  });
  const input = { root: "/workspace/project", config, fs };
  assert.deepEqual((await runRules(input)).violations, []);

  files["../package.json"] = JSON.stringify({ type: "commonjs" });
  const changed = await runRules(input);
  assert.deepEqual(
    changed.violations.map(({ rule }) => rule),
    ["layer-boundary"]
  );
  assert.ok(
    graphEnclosingPackageManifestFiles(input.root, ["src/app.ts"]).includes(
      path.join("/workspace", "package.json")
    )
  );
});

test("graph finds a cycle spanning more than two files", () => {
  const graph = graphFor({
    "src/a.ts": 'import "./b";',
    "src/b.ts": 'import "./c";',
    "src/c.ts": 'import "./a";',
  });
  assert.deepEqual(graph.cycles, [["src/a.ts", "src/b.ts", "src/c.ts"]]);
});

test("graph invalidates cached source edges after edits and new files", () => {
  const files: Record<string, string> = {
    "src/a.ts": 'import "./b";',
    "src/b.ts": "export {};",
  };
  const fs = memoryFileSystem(files);
  const config = resolveConfig({});
  const ctx = {
    root: "/virtual-cache",
    config,
    options: {},
    inLayer: () => true,
    hasLayer: (layer: string) => config.layers[layer] !== undefined,
    files: [],
    listFiles: (extensions?: string[]) =>
      fs
        .list()
        .filter(
          (file) =>
            !extensions ||
            extensions.some((extension) => file.endsWith(extension))
        ),
    read: fs.read,
  };
  assert.deepEqual(
    buildProjectGraph(ctx).edges.map((edge) => edge.to),
    ["src/b.ts"]
  );
  files["src/a.ts"] = 'import "./c";';
  files["src/c.ts"] = "export {};";
  assert.deepEqual(
    buildProjectGraph(ctx).edges.map((edge) => edge.to),
    ["src/c.ts"]
  );
});

test("graph findings refresh when an inherited tsconfig outside the root changes", async () => {
  const root = "/workspace/project";
  const files: Record<string, string> = {
    "tsconfig.json": JSON.stringify({
      extends: "../shared/tsconfig.base.json",
    }),
    "../shared/tsconfig.base.json": JSON.stringify({
      compilerOptions: {
        baseUrl: "../project",
        paths: { "@/*": ["src/*"] },
      },
    }),
    "src/a.ts": 'import "@/b";',
    "src/b.ts": 'import "./a";',
  };
  const baseFs = memoryFileSystem(files);
  const fs = {
    list: () => baseFs.list().filter((file) => file.startsWith("src/")),
    listDirectory: baseFs.listDirectory,
    read: baseFs.read,
  };
  const config = resolveConfig({
    scan: ["src"],
    rules: { "circular-dependency": "error" },
  });
  const input = { root, config, fs };
  assert.equal((await runRules(input)).violations.length, 1);
  files["../shared/tsconfig.base.json"] = JSON.stringify({
    compilerOptions: {
      baseUrl: "../project",
      paths: { "@/*": ["src/other/*"] },
    },
  });
  assert.deepEqual((await runRules(input)).violations, []);
});

test("graph includes self-import cycles", () => {
  const graph = graphFor({ "src/a.ts": 'import "./a";' });
  assert.deepEqual(graph.cycles, [["src/a.ts"]]);
});

test("graph reports type-only cycles as their own finding", async () => {
  const fs = memoryFileSystem({
    "src/a.ts": 'import { type B } from "./b";',
    "src/b.ts": 'import { type A } from "./a";',
  });
  const config = resolveConfig({
    rules: { "type-circular-dependency": "error" },
  });
  const result = await runRules({
    root: "/virtual-type-cycle",
    config,
    fs,
    only: ["type-circular-dependency"],
  });
  assert.equal(result.violations[0]?.rule, "type-circular-dependency");
});

test("runRules counts scanned JavaScript and Dart sources, excluding tests and declarations", async () => {
  const fs = memoryFileSystem({
    "src/a.js": 'import "./b.js";',
    "src/b.js": 'import "./a.js";',
    "src/ignored.test.js": "export {};",
    "src/types.d.ts": "export {};",
    "lib/app.dart": "void main() {}",
  });
  const result = await runRules({
    root: "/virtual-source-count",
    config: resolveConfig({
      rules: { "circular-dependency": "error" },
    }),
    fs,
  });

  assert.equal(result.scanned, 3);
  assert.equal(result.violations.length, 1);
});

test("graph enforces allowed layer dependencies and context public ports", async () => {
  const files = {
    "src/web/page.ts": 'import "../core/internal";',
    "src/core/internal.ts": "export const value = 1;",
  };
  const fs = memoryFileSystem(files);
  const config = resolveConfig({
    layers: { web: ["src/web/"], core: ["src/core/"] },
    abstractLayers: ["core"],
    allowedDependencies: { web: ["core"] },
    contexts: [
      { name: "web-app", layers: ["web"], public: ["web"] },
      { name: "core-domain", layers: ["core"], public: [] },
    ],
    rules: { "architecture-graph": "error" },
  });
  const result = await runRules({
    root: "/virtual",
    config,
    fs,
    only: ["architecture-graph"],
  });
  assert.deepEqual(
    result.violations.map((violation) => violation.rule).sort(),
    ["context-boundary"]
  );
});

test("graph rejects dependency policies that name undefined layers", async () => {
  const fs = memoryFileSystem({ "src/a.ts": "export {};" });
  const config = resolveConfig({
    layers: { app: ["src/"] },
    allowedDependencies: { app: ["missing"] },
    rules: { "architecture-graph": "error" },
  });
  await assert.rejects(
    runRules({ root: "/virtual", config, fs, only: ["architecture-graph"] }),
    /allowedDependencies\.app references unknown layer "missing"/
  );
});

test("graph reports cross-team dependencies and their mismatch index", async () => {
  const fs = memoryFileSystem({
    "src/app/page.ts": 'import "../domain/model"; import "../domain/service";',
    "src/domain/model.ts": "export {};",
    "src/domain/service.ts": 'import "./model";',
    "src/shared/log.ts": "export {};",
  });
  const config = resolveConfig({
    layers: {
      app: ["src/app/"],
      domain: ["src/domain/"],
      shared: ["src/shared/"],
    },
    teams: { product: ["app"], platform: ["domain", "shared"] },
    rules: { "team-boundary": "error" },
  });
  const result = await runRules({
    root: "/virtual-team-boundary",
    config,
    fs,
    only: ["team-boundary"],
  });
  assert.equal(result.violations.length, 2);
  assert.ok(
    result.violations.every((violation) =>
      violation.message.includes("Conway mismatch index 2/2 (100%)")
    )
  );
});

test("graph rejects team ownership of undefined or duplicate layers", async () => {
  const fs = memoryFileSystem({ "src/a.ts": "export {};" });
  const unknownLayer = resolveConfig({
    layers: { app: ["src/"] },
    teams: { product: ["missing"] },
    rules: { "team-boundary": "error" },
  });
  await assert.rejects(
    runRules({ root: "/virtual", config: unknownLayer, fs }),
    /teams\.product references unknown layer "missing"/
  );
  const duplicateOwner = resolveConfig({
    layers: { app: ["src/"] },
    teams: { product: ["app"], platform: ["app"] },
    rules: { "team-boundary": "error" },
  });
  await assert.rejects(
    runRules({ root: "/virtual", config: duplicateOwner, fs }),
    /layer "app" belongs to both team "product" and "platform"/
  );
  const emptyOwner = resolveConfig({
    layers: { app: ["src/"] },
    teams: { "": ["app"], product: ["app"] },
    rules: { "team-boundary": "error" },
  });
  await assert.rejects(
    runRules({ root: "/virtual", config: emptyOwner, fs }),
    /teams contains an empty team name/
  );
});

test("graph reports cycles between workspace packages", async () => {
  const files = {
    "packages/a/package.json": JSON.stringify({
      name: "@sample/a",
      exports: { ".": "./src/index.ts" },
    }),
    "packages/b/package.json": JSON.stringify({
      name: "@sample/b",
      exports: { ".": "./src/index.ts" },
    }),
    "packages/a/src/index.ts": 'import "@sample/b";',
    "packages/b/src/index.ts": 'import "@sample/a";',
  };
  const fs = memoryFileSystem(files);
  const config = resolveConfig({
    scan: ["packages"],
    rules: { "package-circular-dependency": "error" },
  });
  const result = await runRules({
    root: "/virtual-package-cycle",
    config,
    fs,
    only: ["package-circular-dependency"],
  });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.message, /@sample\/a, @sample\/b/);
  files["packages/b/package.json"] = JSON.stringify({ name: "@changed/b" });
  files["packages/a/src/index.ts"] = 'import "@changed/b";';
  const refreshed = await runRules({
    root: "/virtual-package-cycle",
    config,
    fs,
    only: ["package-circular-dependency"],
  });
  assert.match(refreshed.violations[0]!.message, /@changed\/b/);
});

test("hub-module uses distinct importer and dependency counts", async () => {
  const fs = memoryFileSystem({
    "src/incoming/one.ts": 'import "../hub";',
    "src/incoming/two.ts": 'import "../hub";',
    "src/hub.ts": 'import "./out-one"; import "./out-two";',
    "src/out-one.ts": "export {};",
    "src/out-two.ts": "export {};",
  });
  const config = resolveConfig({
    rules: {
      "hub-module": {
        level: "error",
        options: { minFanIn: 2, minFanOut: 2 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-hub-module",
    config,
    fs,
    only: ["hub-module"],
  });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.file, "src/hub.ts");
  assert.match(result.violations[0]!.message, /fan-in 2 and fan-out 2/);
});

test("high-coupling checks incoming and outgoing limits independently", async () => {
  const fs = memoryFileSystem({
    "src/center.ts": 'import "./one"; import "./two";',
    "src/one.ts": "export {};",
    "src/two.ts": "export {};",
  });
  const config = resolveConfig({
    rules: {
      "high-coupling": {
        level: "error",
        options: { maxFanIn: 10, maxFanOut: 1 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-high-coupling",
    config,
    fs,
    only: ["high-coupling"],
  });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.file, "src/center.ts");
  assert.match(result.violations[0]!.message, /fan-out 2 \(max 1\)/);
});

test("high-coupling ignores invalid options for disabled hub-module", async () => {
  const config = resolveConfig({
    rules: {
      "hub-module": { level: "off", options: { minFanIn: 0 } },
      "high-coupling": { level: "error" },
    },
  });
  const result = await runRules({
    root: "/virtual-disabled-hub-options",
    config,
    fs: memoryFileSystem({ "src/a.ts": "export {};" }),
    only: ["high-coupling"],
  });
  assert.deepEqual(result.violations, []);
});

test("hub-dependency detects widely used declared external packages", async () => {
  const fs = memoryFileSystem({
    "package.json": JSON.stringify({
      dependencies: { "@sample/ui": "1.0.0" },
    }),
    "src/a.ts": 'import "@sample/ui/button";',
    "src/b.ts": 'import "@sample/ui";',
  });
  const config = resolveConfig({
    rules: {
      "hub-dependency": {
        level: "error",
        options: { maxImporters: 1 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-hub-dependency",
    config,
    fs,
    only: ["hub-dependency"],
  });
  assert.equal(result.violations.length, 1);
  assert.match(
    result.violations[0]!.message,
    /@sample\/ui is imported by 2 files/
  );
});

test("vendor-coupling flags external packages used across layers", async () => {
  const config = resolveConfig({
    layers: { app: ["src/app/"], domain: ["src/domain/"] },
    rules: { "vendor-coupling": "error" },
  });
  const result = await runRules({
    root: "/virtual-vendor-coupling",
    config,
    fs: memoryFileSystem({
      "package.json": JSON.stringify({
        dependencies: { "date-fns": "1.0.0" },
      }),
      "src/app/date.ts": 'import { format } from "date-fns/format"; format;',
      "src/domain/date.ts": 'import { parseISO } from "date-fns"; parseISO;',
    }),
    only: ["vendor-coupling"],
  });
  assert.deepEqual(
    result.violations.map(({ file, rule, message }) => [file, rule, message]),
    [
      [
        "src/app/date.ts",
        "vendor-coupling",
        "External dependency date-fns is imported across 2 architectural layers (max 1); add a project-owned adapter or narrow its use",
      ],
    ]
  );
});

test("graph thresholds reject null instead of applying defaults", async () => {
  const cases = [
    {
      rule: "vendor-coupling",
      options: { maxLayers: null },
      error: /vendor-coupling maxLayers must be a positive integer/,
    },
    {
      rule: "vendor-coupling",
      options: { ignore: null },
      error: /vendor-coupling ignore must be an array of package names/,
    },
    {
      rule: "max-instability",
      options: { max: null },
      error: /max-instability max must be between 0 and 1/,
    },
    {
      rule: "team-mismatch",
      options: { maxRatio: null },
      error: /team-mismatch maxRatio must be between 0 and 1/,
    },
  ] as const;
  for (const [index, entry] of cases.entries()) {
    const config = resolveConfig({
      defaultLevel: "off",
      rules: {
        [entry.rule]: { level: "error", options: entry.options },
      },
    });
    await assert.rejects(
      runRules({
        root: `/virtual-invalid-graph-option-${index}`,
        config,
        fs: memoryFileSystem({ "src/a.ts": "export {};" }),
        only: [entry.rule],
      }),
      entry.error
    );
  }
});

test("max-instability gates layers over its configured ceiling", async () => {
  const config = resolveConfig({
    layers: { app: ["src/app/"], domain: ["src/domain/"] },
    rules: {
      "max-instability": {
        level: "error",
        options: { max: 0.5 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-max-instability",
    config,
    fs: memoryFileSystem({
      "src/app/page.ts": 'import "../domain/model";',
      "src/domain/model.ts": "export {};",
    }),
    only: ["max-instability"],
  });
  assert.deepEqual(
    result.violations.map(({ file, rule, message }) => [file, rule, message]),
    [
      [
        "src/app/page.ts",
        "max-instability",
        "app has instability 1.00, above the maximum 0.5",
      ],
    ]
  );
  assert.deepEqual(result.violations[0]?.metrics, {
    instability: { value: 1, worsening: "higher" },
  });
});

test("team-mismatch gates layers above their owned dependency ratio", async () => {
  const config = resolveConfig({
    layers: {
      app: ["src/app/"],
      domain: ["src/domain/"],
      shared: ["src/shared/"],
    },
    teams: { product: ["app"], platform: ["domain", "shared"] },
    rules: {
      "team-mismatch": {
        level: "error",
        options: { maxRatio: 0.75 },
      },
    },
  });
  const result = await runRules({
    root: "/virtual-team-mismatch-ratio",
    config,
    fs: memoryFileSystem({
      "src/app/page.ts": 'import "../domain/model";',
      "src/domain/model.ts": 'import "../shared/log";',
      "src/shared/log.ts": "export {};",
    }),
    only: ["team-mismatch"],
  });
  assert.deepEqual(
    result.violations.map(({ file, rule, message }) => [file, rule, message]),
    [
      [
        "src/app/page.ts",
        "team-mismatch",
        "app (product) crosses team ownership on 1/1 incident dependencies (100%), above the maximum 75%",
      ],
    ]
  );
});

test("side-effect-import reports local imports without bindings", async () => {
  const fs = memoryFileSystem({
    "package.json": JSON.stringify({
      dependencies: { "reflect-metadata": "1.0.0" },
    }),
    "src/app.ts": [
      'import "./polyfill";',
      'import "reflect-metadata";',
      'import { value } from "./value";',
    ].join("\n"),
    "src/polyfill.ts": "globalThis.ready = true;",
    "src/value.ts": "export const value = 1;",
  });
  const config = resolveConfig({ rules: { "side-effect-import": "error" } });
  const result = await runRules({
    root: "/virtual-side-effect-import",
    config,
    fs,
    only: ["side-effect-import"],
  });
  assert.equal(result.violations.length, 2);
  assert.equal(result.violations[0]!.file, "src/app.ts");
  assert.ok(
    result.violations.some((violation) =>
      violation.message.includes("src/polyfill.ts")
    )
  );
  assert.ok(
    result.violations.some((violation) =>
      violation.message.includes("reflect-metadata")
    )
  );
});

test("test-file-leakage finds production imports of test files", async () => {
  const fs = memoryFileSystem({
    "src/app.ts": 'import { helper } from "../tests/helper.test";\nhelper();',
    "tests/helper.test.ts": "export function helper() {}",
  });
  const config = resolveConfig({
    scan: ["src", "tests"],
    rules: { "test-file-leakage": "error" },
  });
  const result = await runRules({
    root: "/virtual-test-file-leakage",
    config,
    fs,
    only: ["test-file-leakage"],
  });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]!.file, "src/app.ts");
  assert.match(result.violations[0]!.message, /tests\/helper\.test\.ts/);
});

test("test-file-leakage resolves test targets outside configured scan roots", async () => {
  const config = resolveConfig({
    scan: ["src"],
    rules: { "test-file-leakage": "error" },
  });
  const result = await runRules({
    root: "/virtual-test-file-leakage-outside-scan",
    config,
    fs: memoryFileSystem({
      "src/app.ts": 'import { helper } from "../tests/helper.test";\nhelper();',
      "tests/helper.test.ts": "export function helper() {}",
    }),
    only: ["test-file-leakage"],
  });
  assert.equal(result.violations.length, 1);
  assert.match(result.violations[0]!.message, /tests\/helper\.test\.ts/);
});

test("edge findings use distinct identities for repeated imports", async () => {
  const config = resolveConfig({
    layers: { app: ["src/app/"], internal: ["src/internal/"] },
    allowedDependencies: { app: [] },
    contexts: [
      { name: "app", layers: ["app"], public: [] },
      { name: "core", layers: ["internal"], public: [] },
    ],
    rules: {
      "layer-boundary": "error",
      "context-boundary": "error",
      "side-effect-import": "error",
      "test-file-leakage": "error",
    },
  });
  const result = await runRules({
    root: "/virtual-edge-identities",
    config,
    fs: memoryFileSystem({
      "src/app/main.ts": [
        'import "../internal/file";',
        'import "../internal/file";',
        'import { helper } from "../../tests/helper.test";',
        'import { helper } from "../../tests/helper.test";',
      ].join("\n"),
      "src/internal/file.ts": "export {};",
      "tests/helper.test.ts": "export function helper() {}",
    }),
    only: [
      "layer-boundary",
      "context-boundary",
      "side-effect-import",
      "test-file-leakage",
    ],
  });
  for (const rule of [
    "layer-boundary",
    "context-boundary",
    "side-effect-import",
    "test-file-leakage",
  ]) {
    const findings = result.violations.filter(
      (violation) => violation.rule === rule
    );
    assert.equal(findings.length, 2, rule);
    assert.equal(
      new Set(findings.map((finding) => finding.identity)).size,
      2,
      rule
    );
  }
});

test("graph metrics report fan-in, layer Ca/Ce/I/A/D and team mismatch", () => {
  const graph = graphFor({
    "src/app/page.ts": 'import "../domain/model";',
    "src/domain/model.ts": 'import "../shared/log";',
    "src/shared/log.ts": "export {};",
  });
  const config = resolveConfig({
    layers: {
      app: ["src/app/"],
      domain: ["src/domain/"],
      shared: ["src/shared/"],
    },
    teams: { product: ["app"], platform: ["domain", "shared"] },
    abstractLayers: ["domain"],
  });
  const metrics = architectureMetrics(graph, config);
  assert.deepEqual(
    metrics.files.map(({ file, fanIn, fanOut }) => [file, fanIn, fanOut]),
    [
      ["src/app/page.ts", 0, 1],
      ["src/domain/model.ts", 1, 1],
      ["src/shared/log.ts", 1, 0],
    ]
  );
  assert.deepEqual(metrics.layers, [
    { layer: "app", Ca: 0, Ce: 1, I: 1, A: 0, D: 0, team: "product" },
    { layer: "domain", Ca: 1, Ce: 1, I: 0.5, A: 1, D: 0.5, team: "platform" },
    { layer: "shared", Ca: 1, Ce: 0, I: 0, A: 0, D: 1, team: "platform" },
  ]);
  assert.equal(metrics.teamMismatch.crossTeamDependencies, 1);
  assert.equal(metrics.teamMismatch.ownedDependencies, 2);
  assert.equal(metrics.teamMismatch.ratio, 0.5);
  assert.deepEqual(metrics.teamMismatch.byLayer, [
    {
      layer: "app",
      team: "product",
      crossTeamDependencies: 1,
      ownedDependencies: 1,
      ratio: 1,
    },
    {
      layer: "domain",
      team: "platform",
      crossTeamDependencies: 1,
      ownedDependencies: 2,
      ratio: 0.5,
    },
    {
      layer: "shared",
      team: "platform",
      crossTeamDependencies: 0,
      ownedDependencies: 1,
      ratio: 0,
    },
  ]);
});

test("graph metrics reject duplicate team ownership", () => {
  const config = resolveConfig({
    layers: { app: ["src/app/"] },
    teams: { alpha: ["app"], beta: ["app"] },
  });
  assert.throws(
    () =>
      architectureMetrics(
        { files: ["src/app/page.ts"], edges: [], cycles: [] },
        config
      ),
    /belongs to both team "alpha" and "beta"/
  );
});

test("team mismatch denominator includes same-team edges and dedupes file pairs", async () => {
  const fs = memoryFileSystem({
    "src/app/page.ts":
      'import "../domain/model"; import "../domain/model"; import "../domain/service";',
    "src/domain/model.ts": "export {};",
    "src/domain/service.ts": 'import "../shared/log";',
    "src/shared/log.ts": "export {};",
  });
  const config = resolveConfig({
    layers: {
      app: ["src/app/"],
      domain: ["src/domain/"],
      shared: ["src/shared/"],
    },
    teams: { product: ["app"], platform: ["domain", "shared"] },
    rules: { "team-boundary": "error" },
  });
  const result = await runRules({
    root: "/virtual-team-mismatch-denominator",
    config,
    fs,
    only: ["team-boundary"],
  });
  assert.equal(result.violations.length, 2);
  assert.ok(
    result.violations.every((violation) =>
      violation.message.includes("Conway mismatch index 2/3 (67%)")
    )
  );
});

test("stable dependency identities distinguish target files within one layer", async () => {
  const fs = memoryFileSystem({
    "src/app/page.ts": 'import "../domain/model"; import "../domain/service";',
    "src/domain/model.ts": 'import "../external/util";',
    "src/domain/service.ts": 'import "../external/util";',
    "src/external/util.ts": "export {};",
    "src/entry/a.ts": 'import "../app/page";',
    "src/entry/b.ts": 'import "../app/page";',
    "src/entry/c.ts": 'import "../app/page";',
    "src/entry/d.ts": 'import "../app/page";',
  });
  const config = resolveConfig({
    layers: {
      app: ["src/app/"],
      domain: ["src/domain/"],
      external: ["src/external/"],
      entryA: ["src/entry/a.ts"],
      entryB: ["src/entry/b.ts"],
      entryC: ["src/entry/c.ts"],
      entryD: ["src/entry/d.ts"],
    },
    rules: { "stable-dependencies": "error" },
  });
  const result = await runRules({
    root: "/virtual-stable-dependency-identities",
    config,
    fs,
    only: ["stable-dependencies"],
  });
  const findings = result.violations.filter(
    (violation) => violation.rule === "stable-dependencies"
  );
  assert.equal(findings.length, 2);
  assert.equal(
    new Set(findings.map((finding) => finding.identity)).size,
    findings.length
  );
});

test("ADR directives add declared layers and report denied imports", async () => {
  const fs = memoryFileSystem({
    "src/service/a.ts": 'import "../db/query";',
    "src/db/query.ts": "export {};",
    "docs/adr/001-boundaries.md": [
      "# Boundaries",
      "```archlint",
      "layer service = src/service/",
      "layer db = src/db/",
      "deny service -> db",
      "```",
    ].join("\n"),
  });
  const config = resolveConfig({
    adrDir: "docs/adr",
    rules: { "layer-boundary": "error" },
  });
  const result = await runRules({
    root: "/virtual-adr",
    config,
    fs,
    only: ["layer-boundary"],
  });
  assert.match(
    result.violations[0]?.message ?? "",
    /denied by docs\/adr\/001-boundaries\.md:5/
  );
});

test("ADR directives remain active outside scan roots with normalized paths", async () => {
  const baseFs = memoryFileSystem({
    "src/service/a.ts": 'import "../db/query";',
    "src/db/query.ts": "export {};",
    "docs/adr/001-boundaries.md": [
      "# Boundaries",
      "```archlint",
      "layer service = src/service/",
      "layer db = src/db/",
      "deny service -> db",
      "```",
    ].join("\n"),
  });
  const fs = {
    list: () => baseFs.list().filter((file) => file.startsWith("src/")),
    listDirectory: baseFs.listDirectory,
    read: baseFs.read,
  };
  for (const [index, adrDir] of ["docs/adr", "./docs/adr/"].entries()) {
    const config = resolveConfig({
      scan: ["src"],
      adrDir,
      rules: { "layer-boundary": "error" },
    });
    const result = await runRules({
      root: `/virtual-scoped-adr-${index}`,
      config,
      fs,
      only: ["layer-boundary"],
    });
    assert.match(
      result.violations[0]?.message ?? "",
      /denied by docs\/adr\/001-boundaries\.md:5/
    );
  }
});

test("ADR deny that conflicts with configured allow fails with both sources", async () => {
  const fs = memoryFileSystem({
    "src/service/a.ts": 'import "../db/query";',
    "src/db/query.ts": "export {};",
    "docs/adr/001-boundaries.md": [
      "# Boundaries",
      "```archlint",
      "layer service = src/service/",
      "layer db = src/db/",
      "deny service -> db",
      "```",
    ].join("\n"),
  });
  const config = resolveConfig({
    adrDir: "docs/adr",
    layers: { service: ["src/service/"], db: ["src/db/"] },
    allowedDependencies: { service: ["db"] },
    rules: { "layer-boundary": "error" },
  });
  await assert.rejects(
    runRules({
      root: "/virtual-adr-allow-conflict",
      config,
      fs,
      only: ["layer-boundary"],
    }),
    /docs\/adr\/001-boundaries\.md:5 denies service -> db, but arch-lint\.config\.json allows it/
  );
});

test("ADR allow and deny directives reject unknown layer names", async () => {
  const config = resolveConfig({
    adrDir: "docs/adr",
    layers: { app: ["src/app/"], db: ["src/db/"] },
    rules: { "layer-boundary": "error" },
  });
  for (const [index, directive] of [
    "allow ghost -> db",
    "deny ghost -> db",
    "allow app -> ghost",
    "deny app -> ghost",
  ].entries()) {
    const fs = memoryFileSystem({
      "docs/adr/001-boundaries.md": ["```archlint", directive, "```"].join(
        "\n"
      ),
    });
    await assert.rejects(
      runRules({
        root: `/virtual-adr-unknown-layer-${index}`,
        config,
        fs,
        only: ["layer-boundary"],
      }),
      /docs\/adr\/001-boundaries\.md:2 references unknown layer "ghost"/
    );
  }
});

test("graph emits stability, distance, cohesion, and co-change findings", async () => {
  const files = {
    "src/a.ts": [
      'import "./b";',
      'import "./c";',
      'import "./d";',
      'import "./e";',
      "class Split { first() { return 1; } second() { return 2; } }",
    ].join("\n"),
    "src/b.ts": 'import "./c"; import "./d";',
    "src/c.ts": 'import "./a";',
    "src/d.ts": 'import "./a";',
    "src/e.ts": "export {};",
  };
  const fs = memoryFileSystem(files);
  const config = resolveConfig({
    layers: {
      a: ["src/a.ts"],
      b: ["src/b.ts"],
      c: ["src/c.ts"],
      d: ["src/d.ts"],
      e: ["src/e.ts"],
    },
    rules: {
      "stable-dependencies": "error",
      "stability-distance": "error",
      lcom4: "error",
    },
  });
  const result = await runRules({
    root: "/virtual-metrics",
    config,
    fs,
    only: ["stable-dependencies", "stability-distance", "lcom4"],
  });
  assert.ok(
    result.violations.some(
      (violation) => violation.rule === "stable-dependencies"
    )
  );
  assert.ok(result.violations.some((violation) => violation.rule === "lcom4"));
  assert.ok(
    result.violations.some(
      (violation) => violation.rule === "stability-distance"
    )
  );
  const coChanges = "\x01\nsrc/a.ts\nsrc/b.ts\n\x01\nsrc/a.ts\nsrc/b.ts\n";
  assert.equal(
    coChangeFindingsFromLog(
      coChanges,
      { files: ["src/a.ts", "src/b.ts"], edges: [], cycles: [] },
      2
    )[0]?.rule,
    "shotgun-surgery"
  );
  assert.deepEqual(
    coChangeFindingsFromLog(
      coChanges,
      { files: ["src/a.ts", "src/b.ts"], edges: [], cycles: [] },
      3
    ),
    []
  );
});

test("graph detectors leave an unrelated project alone", async () => {
  for (const rule of architectureGraphRuleIds) {
    const config = resolveConfig({ rules: { [rule]: "error" } });
    const result = await runRules({
      root: "/virtual-clean-graph",
      config,
      fs: memoryFileSystem({ "src/a.ts": "export const value = 1;" }),
      only: [rule],
    });
    assert.deepEqual(
      result.violations,
      [],
      `${rule} should ignore a clean graph`
    );
  }
});

test("co-change cache revision changes when the repository receives a commit", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-history-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    execFileSync("git", ["-C", root, "config", "user.name", "arch-lint test"]);
    execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "test@example.com",
    ]);
    writeFileSync(path.join(root, "file.txt"), "content\n");
    execFileSync("git", ["-C", root, "add", "file.txt"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "initial"]);
    const first = coChangeRevision(root);
    execFileSync("git", [
      "-C",
      root,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "history",
    ]);
    assert.notEqual(coChangeRevision(root), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("co-change configuration enables findings only when requested", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-cochange-"));
  try {
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    execFileSync("git", ["-C", root, "config", "user.name", "arch-lint test"]);
    execFileSync("git", [
      "-C",
      root,
      "config",
      "user.email",
      "test@example.com",
    ]);
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(root, "b.ts"), "export const b = 1;\n");
    execFileSync("git", ["-C", root, "add", "a.ts", "b.ts"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "initial"]);
    for (let value = 2; value <= 3; value++) {
      writeFileSync(path.join(root, "a.ts"), `export const a = ${value};\n`);
      writeFileSync(path.join(root, "b.ts"), `export const b = ${value};\n`);
      execFileSync("git", ["-C", root, "add", "a.ts", "b.ts"]);
      execFileSync("git", [
        "-C",
        root,
        "commit",
        "--quiet",
        "-m",
        `change ${value}`,
      ]);
    }

    const files = {
      "a.ts": "export const a = 3;\n",
      "b.ts": "export const b = 3;\n",
    };
    const enabled = resolveConfig({
      graph: { coChange: true, coChangeThreshold: 2 },
      rules: { "shotgun-surgery": "error" },
    });
    const disabled = resolveConfig({
      graph: { coChange: false, coChangeThreshold: 2 },
      rules: { "shotgun-surgery": "error" },
    });
    const enabledResult = await runRules({
      root,
      config: enabled,
      fs: memoryFileSystem(files),
      only: ["shotgun-surgery"],
    });
    const disabledResult = await runRules({
      root,
      config: disabled,
      fs: memoryFileSystem(files),
      only: ["shotgun-surgery"],
    });
    assert.equal(enabledResult.violations.length, 1);
    assert.deepEqual(disabledResult.violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graph detector ids can be enabled independently", async () => {
  const fs = memoryFileSystem({
    "src/a.ts": 'import "./b";',
    "src/b.ts": 'import "./a";',
  });
  const config = resolveConfig({
    rules: { "circular-dependency": "error" },
  });
  const result = await runRules({
    root: "/virtual",
    config,
    fs,
    only: ["circular-dependency"],
  });
  assert.deepEqual(
    result.violations.map((violation) => violation.rule),
    ["circular-dependency"]
  );
});

test("aggregate and specific graph rules do not duplicate findings", async () => {
  const config = resolveConfig({
    defaultLevel: "off",
    rules: {
      "architecture-graph": "error",
      "circular-dependency": "error",
    },
  });
  const result = await runRules({
    root: "/virtual-graph-aggregate",
    config,
    fs: memoryFileSystem({
      "src/a.ts": 'import "./b";',
      "src/b.ts": 'import "./a";',
    }),
  });
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0]?.rule, "circular-dependency");
});
