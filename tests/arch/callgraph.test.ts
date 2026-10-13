import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCallGraph } from "../../src/arch/callgraph";

function project(files: Record<string, string>) {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-callgraph-"));
  for (const [file, contents] of Object.entries(files)) {
    const absolute = path.join(root, file);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("callgraph resolves imported calls across files and filters by entry", () => {
  const fixture = project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { module: "esnext", moduleResolution: "bundler" },
      include: ["src/**/*.ts"],
    }),
    "src/start.ts": [
      'import { helper } from "./helper";',
      "export function start() {",
      "  helper();",
      "  console.log('unresolved library call');",
      "}",
      "export function unrelated() {}",
    ].join("\n"),
    "src/helper.ts": [
      'import { finish } from "./finish";',
      "export function helper() { finish(); }",
    ].join("\n"),
    "src/finish.ts": "export function finish() {}",
    "src/other.ts": "export function elsewhere() {}",
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      entryFile: "src/start.ts",
      functionName: "start",
    });
    assert.deepEqual(
      graph.functions.map(({ name, file }) => [name, file]),
      [
        ["finish", "src/finish.ts"],
        ["helper", "src/helper.ts"],
        ["start", "src/start.ts"],
      ]
    );
    assert.deepEqual(
      graph.calls.map(({ from, to, file, line, kind }) => [
        from.split(":").at(-1),
        to.split(":").at(-1),
        file,
        line,
        kind,
      ]),
      [
        ["helper", "finish", "src/helper.ts", 2, "call"],
        ["start", "helper", "src/start.ts", 3, "call"],
      ]
    );
  } finally {
    fixture.cleanup();
  }
});

test("callgraph uses the nearest nested jsconfig aliases", () => {
  const fixture = project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { allowJs: true, module: "esnext" },
      include: ["apps/**/*.js"],
    }),
    "apps/web/jsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
        module: "esnext",
        moduleResolution: "bundler",
      },
      include: ["src/**/*.js"],
    }),
    "apps/web/src/main.js": [
      'import { helper } from "@/helper";',
      "export function start() { helper(); }",
    ].join("\n"),
    "apps/web/src/helper.js": "export function helper() {}",
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      entryFile: "apps/web/src/main.js",
      functionName: "start",
    });
    assert.deepEqual(
      graph.functions.map(({ name, file }) => [name, file]),
      [
        ["helper", "apps/web/src/helper.js"],
        ["start", "apps/web/src/main.js"],
      ]
    );
    assert.equal(graph.calls.length, 1);
    assert.equal(graph.calls[0]?.to.split(":").at(-1), "helper");
  } finally {
    fixture.cleanup();
  }
});

test("callgraph scans unconfigured files beside nested projects", () => {
  const fixture = project({
    "apps/web/tsconfig.json": JSON.stringify({
      compilerOptions: { module: "esnext", moduleResolution: "bundler" },
      include: ["src/**/*.ts"],
    }),
    "apps/web/src/app.ts": "export function app() {}",
    "scripts/task.ts": "export function task() {}",
  });

  try {
    const graph = buildCallGraph({ root: fixture.root });
    assert.deepEqual(
      graph.functions.map(({ name, file }) => [name, file]),
      [
        ["app", "apps/web/src/app.ts"],
        ["task", "scripts/task.ts"],
      ]
    );
  } finally {
    fixture.cleanup();
  }
});

test("callgraph resolves local constructors and keeps relative paths", () => {
  const fixture = project({
    "src/main.ts": [
      "class Widget {",
      "  constructor() { this.run(); }",
      "  run() { work(); }",
      "}",
      "function work() {}",
      "export function launch() { new Widget(); }",
    ].join("\n"),
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      functionName: "launch",
    });
    assert.deepEqual(
      graph.functions.map(({ name, file }) => [name, file]),
      [
        ["Widget.constructor", "src/main.ts"],
        ["Widget.run", "src/main.ts"],
        ["work", "src/main.ts"],
        ["launch", "src/main.ts"],
      ]
    );
    assert.deepEqual(
      graph.calls.map(({ from, to, line, kind }) => [
        from.split(":").at(-1),
        to.split(":").at(-1),
        line,
        kind,
      ]),
      [
        ["Widget.constructor", "Widget.run", 2, "call"],
        ["Widget.run", "work", 3, "call"],
        ["launch", "Widget.constructor", 6, "construct"],
      ]
    );
  } finally {
    fixture.cleanup();
  }
});

test("callgraph resolves JavaScript arrow-function exports", () => {
  const fixture = project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { allowJs: true, module: "esnext" },
      include: ["src/**/*.js"],
    }),
    "src/start.js": [
      'import { helper } from "./helper.js";',
      "export function start() { helper(); }",
    ].join("\n"),
    "src/helper.js": "export const helper = () => {};",
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      entryFile: "src/start.js",
      functionName: "start",
    });
    assert.deepEqual(
      graph.functions.map(({ name, file }) => [name, file]),
      [
        ["helper", "src/helper.js"],
        ["start", "src/start.js"],
      ]
    );
    assert.deepEqual(
      graph.calls.map(({ from, to, file, line }) => [
        from.split(":").at(-1),
        to.split(":").at(-1),
        file,
        line,
      ]),
      [["start", "helper", "src/start.js", 2]]
    );
  } finally {
    fixture.cleanup();
  }
});

test("callgraph omits calls resolved to JavaScript package code", () => {
  const fixture = project({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { allowJs: true, module: "esnext" },
      include: ["src/**/*.ts"],
    }),
    "src/start.ts": [
      'import { libraryCall } from "sample-lib";',
      "export function start() { libraryCall(); }",
    ].join("\n"),
    "node_modules/sample-lib/package.json": JSON.stringify({
      main: "index.js",
    }),
    "node_modules/sample-lib/index.js": "export const libraryCall = () => {};",
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      entryFile: "src/start.ts",
      functionName: "start",
    });
    assert.deepEqual(
      graph.functions.map(({ name, file }) => [name, file]),
      [["start", "src/start.ts"]]
    );
    assert.deepEqual(graph.calls, []);
  } finally {
    fixture.cleanup();
  }
});

test("callgraph filters by entry file and returns empty for unmatched filters", () => {
  const fixture = project({
    "src/a.ts": "export function same() {}",
    "src/b.ts": "export function same() {}",
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      entryFile: "src/b.ts",
      functionName: "same",
    });
    assert.deepEqual(
      graph.functions.map(({ file, name }) => [file, name]),
      [["src/b.ts", "same"]]
    );
    assert.deepEqual(
      buildCallGraph({
        root: fixture.root,
        entryFile: "../outside.ts",
      }),
      { functions: [], calls: [] }
    );
  } finally {
    fixture.cleanup();
  }
});

test("callgraph keeps same-line object methods as distinct functions", () => {
  const fixture = project({
    "src/main.ts": [
      "function firstWork() {}",
      "function secondWork() {}",
      "const first = { run() { firstWork(); } }; const second = { run() { secondWork(); } };",
      "export function start() { first.run(); second.run(); }",
    ].join("\n"),
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      entryFile: "src/main.ts",
      functionName: "start",
    });
    const methods = graph.functions.filter(({ name }) => name === "run");
    assert.equal(methods.length, 2);
    assert.equal(new Set(methods.map(({ id }) => id)).size, 2);
    assert.equal(
      new Set(
        graph.calls
          .filter(({ to }) =>
            ["firstWork", "secondWork"].some((name) => to.endsWith(`:${name}`))
          )
          .map(({ from }) => from)
      ).size,
      2
    );
  } finally {
    fixture.cleanup();
  }
});

test("callgraph resolves JavaScript aliases from jsconfig.json", () => {
  const fixture = project({
    "jsconfig.json": JSON.stringify({
      compilerOptions: {
        allowJs: true,
        baseUrl: ".",
        paths: { "@/*": ["src/*"] },
      },
      include: ["src/**/*.js"],
    }),
    "src/start.js": [
      'import { helper } from "@/helper";',
      "export function start() { helper(); }",
    ].join("\n"),
    "src/helper.js": "export function helper() {}",
  });

  try {
    const graph = buildCallGraph({
      root: fixture.root,
      entryFile: "src/start.js",
      functionName: "start",
    });
    assert.deepEqual(
      graph.functions.map(({ name, file }) => [name, file]),
      [
        ["helper", "src/helper.js"],
        ["start", "src/start.js"],
      ]
    );
    assert.equal(graph.calls.length, 1);
  } finally {
    fixture.cleanup();
  }
});
