import assert from "node:assert/strict";
import test from "node:test";
import { RULES, findWholeDirTarget } from "../../src/arch/rules/hygiene";
import { check, checkProject } from "./helpers";

const lines = (...l: string[]) => l.join("\n");

const narration = (text: string, options?: Record<string, unknown>) =>
  check("no-narration-comments", "src/a.ts", text, { options });

const narrationLines = async (
  text: string,
  options?: Record<string, unknown>
) => (await narration(text, options)).map((v) => v.line);

// Skip sets for the three comment-check variants the skip option has to express.
const SKIP_BASIC = [
  "triple-slash",
  "todo-tags-bare",
  "tool-directives-extended",
  "dividers-dashes",
];
const SKIP_MEDIUM = [
  "triple-slash",
  "todo-tags",
  "tool-directives",
  "dividers-dashes",
];
const SKIP_FULL = [
  "triple-slash",
  "todo-tags",
  "tool-directives",
  "dividers",
  "category-markers",
  "dash-headers",
];

test("registers the four hygiene rules", () => {
  assert.deepEqual(
    RULES.map((r) => r.id),
    [
      "no-narration-comments",
      "kebab-case-filenames",
      "test-file-naming",
      "no-whole-dir-test-script",
    ]
  );
  const off = RULES.filter((r) => r.defaultLevel === "off").map((r) => r.id);
  assert.deepEqual(off, ["test-file-naming", "no-whole-dir-test-script"]);
});

test("narration: flags a comment that restates the next line", async () => {
  const found = await narration(
    lines("// set the user name", "const userName = name;"),
    {
      skip: SKIP_MEDIUM,
    }
  );
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, 1);
  assert.equal(found[0]?.rule, "no-narration-comments");
});

test("narration: allows a comment that explains why", async () => {
  const found = await narration(
    lines(
      "// Stripe retries for 3 days, so a late event must stay idempotent.",
      "await handle(event);"
    ),
    { skip: SKIP_MEDIUM }
  );
  assert.equal(found.length, 0);
});

test("narration: ignores TODO markers and suppression comments", async () => {
  const options = { skip: SKIP_MEDIUM };
  assert.equal(
    (await narration(lines("// TODO: remove", "remove();"), options)).length,
    0
  );
  assert.equal(
    (await narration(lines("// biome-ignore lint: x", "x();"), options)).length,
    0
  );
});

test("narration: banned prefix and restated line, reported on the comment line", async () => {
  const options = { skip: SKIP_BASIC, minOverlapWords: 2 };
  const prefix = await narration(
    lines("// Define tabs", "const tabs = [];"),
    options
  );
  assert.equal(prefix.length, 1);
  assert.equal(prefix[0]?.line, 1);
  assert.match(prefix[0]?.message ?? "", /narrates the code/);
  assert.match(prefix[0]?.message ?? "", /"Define tabs"/);

  const restated = await narration(
    lines("// the counter value", "counter.value += 1;"),
    options
  );
  assert.equal(restated.length, 1);
  assert.match(restated[0]?.message ?? "", /67% token overlap/);
});

test("narration: keeps reasoning, directives and short labels (bare tag variant)", async () => {
  const options = { skip: SKIP_BASIC, minOverlapWords: 2 };
  assert.equal(
    (
      await narration(
        lines(
          "// Retry once, the CDN 404s right after upload",
          "await get(url);"
        ),
        options
      )
    ).length,
    0
  );
  assert.equal(
    (await narration(lines("// TODO: remove", "const a = 1;"), options)).length,
    0
  );
  assert.equal(
    (await narration(lines("// Cron", "const cron = 1;"), options)).length,
    0
  );
});

test("narration: minOverlapWords decides whether one word labels are checked", async () => {
  const text = lines("// Cron", "const cron = 1;");
  assert.deepEqual(await narrationLines(text), [1]);
  assert.deepEqual(await narrationLines(text, { minOverlapWords: 2 }), []);
  assert.deepEqual(
    await narrationLines(lines("// cron job", "const cron = 1;"), {
      minOverlapWords: 2,
    }),
    []
  );
  assert.deepEqual(
    await narrationLines(lines("// cron job x", "const cron = job;"), {
      minOverlapWords: 2,
    }),
    [1]
  );
});

test("narration: todo tag variants", async () => {
  const noColon = lines("// TODO user name", 'const userName = "user name";');
  assert.deepEqual(await narrationLines(noColon, { skip: SKIP_MEDIUM }), [1]);
  assert.deepEqual(
    await narrationLines(noColon, { skip: ["todo-tags-bare"] }),
    []
  );

  const lowerColon = lines("// todo: user name", "user.name();");
  assert.deepEqual(
    await narrationLines(lowerColon, { skip: ["todo-tags"] }),
    []
  );
  assert.deepEqual(
    await narrationLines(lowerColon, { skip: ["todo-tags-bare"] }),
    [1]
  );
});

test("narration: tool directive variants", async () => {
  const prettier = lines("// prettier-ignore", "prettier ignore();");
  assert.deepEqual(
    await narrationLines(prettier, { skip: ["tool-directives"] }),
    [1]
  );
  assert.deepEqual(
    await narrationLines(prettier, { skip: ["tool-directives-extended"] }),
    []
  );

  const eslint = lines(
    "// eslint-disable-next-line no-x",
    "eslint disable next line();"
  );
  assert.deepEqual(
    await narrationLines(eslint, { skip: ["tool-directives"] }),
    []
  );
  assert.deepEqual(await narrationLines(eslint, { skip: [] }), [1]);

  const tsDirective = lines(
    "// @ts-expect-error ts expect error",
    "ts expect error();"
  );
  assert.deepEqual(
    await narrationLines(tsDirective, { skip: ["tool-directives"] }),
    []
  );
});

test("narration: triple slash lines", async () => {
  const text = lines("/// reference path", "reference path();");
  assert.deepEqual(await narrationLines(text), []);
  assert.deepEqual(await narrationLines(text, { skip: [] }), [1]);
});

test("narration: divider, category marker and dash header skips", async () => {
  const bullet = lines("// - bullet text", "bullet text();");
  assert.deepEqual(await narrationLines(bullet, { skip: SKIP_FULL }), [1]);
  assert.deepEqual(await narrationLines(bullet, { skip: SKIP_MEDIUM }), []);

  const rule = lines("// ── Name ──", "name();");
  assert.deepEqual(await narrationLines(rule, { skip: SKIP_FULL }), []);
  assert.deepEqual(await narrationLines(rule, { skip: SKIP_MEDIUM }), []);
  assert.deepEqual(await narrationLines(rule, { skip: [] }), [1]);

  const category = lines("// twin.*", "twin: 1,");
  assert.deepEqual(await narrationLines(category, { skip: SKIP_FULL }), []);
  assert.deepEqual(await narrationLines(category, { skip: SKIP_MEDIUM }), [1]);
  assert.deepEqual(await narrationLines(category), []);

  const header = lines("// -- Name --", "name: 1,");
  assert.deepEqual(await narrationLines(header, { skip: SKIP_FULL }), []);
  assert.deepEqual(
    await narrationLines(header, { skip: ["dash-headers"] }),
    []
  );
  assert.deepEqual(await narrationLines(header, { skip: [] }), [1]);
});

test("narration: unknown skip names are ignored", async () => {
  const text = lines("// Define tabs", "const tabs = [];");
  assert.deepEqual(
    await narrationLines(text, { skip: ["constructor", "nope"] }),
    [1]
  );
});

test("narration: threshold, prefix list and prefix word limit are options", async () => {
  const restated = lines("// the counter value", "counter.value += 1;");
  assert.deepEqual(
    await narrationLines(restated, { overlapThreshold: 0.6 }),
    [1]
  );
  assert.deepEqual(
    await narrationLines(restated, { overlapThreshold: 0.7 }),
    []
  );

  assert.deepEqual(
    await narrationLines(lines("// Wire up routes", "register();")),
    []
  );
  assert.deepEqual(
    await narrationLines(lines("// Wire up routes", "register();"), {
      bannedPrefixes: ["Wire up"],
    }),
    [1]
  );
  assert.deepEqual(
    await narrationLines(lines("// Define tabs", "const tabs = [];"), {
      bannedPrefixes: ["wire up"],
    }),
    []
  );

  const long = lines(
    "// Define the new tabs for the page here now",
    "render();"
  );
  assert.deepEqual(await narrationLines(long), []);
  assert.deepEqual(await narrationLines(long, { maxPrefixWords: 10 }), [1]);
});

test("narration: only whole line comments, a closing brace and the next three lines count", async () => {
  assert.deepEqual(await narrationLines("const a = 1; // set the a value"), []);
  assert.deepEqual(
    await narrationLines(lines("// ignore errors here", "}")),
    []
  );
  assert.deepEqual(
    await narrationLines(
      lines("// user name value", "", "", "const user = name value;")
    ),
    [1]
  );
  assert.deepEqual(
    await narrationLines(
      lines("// user name value", "", "", "", "const user = name value;")
    ),
    []
  );
  assert.deepEqual(
    await narrationLines(
      lines("  // set the user name", "  const userName = name;")
    ),
    [1]
  );
});

test("narration: options.message replaces the text and settings control scope", async () => {
  const text = lines("// Define tabs", "const tabs = [];");
  const custom = await narration(text, { message: "Explain why." });
  assert.equal(custom[0]?.message, "Explain why.");

  const exempt = await check("no-narration-comments", "src/a.ts", text, {
    settings: { exempt: { files: ["src/a.ts"] } },
  });
  assert.equal(exempt.length, 0);
  const layered = await check("no-narration-comments", "src/a.ts", text, {
    config: { layers: { backend: ["services/"] } },
    settings: { layer: "backend" },
  });
  assert.equal(layered.length, 0);
});

const kebab = async (
  files: string[],
  opts: Parameters<typeof checkProject>[2] = {}
): Promise<string[]> =>
  (
    await checkProject(
      "kebab-case-filenames",
      Object.fromEntries(files.map((f) => [f, ""])),
      opts
    )
  )
    .map((v) => v.file)
    .sort();

test("kebab: flags uppercase base names at line 0", async () => {
  const found = await checkProject(
    "kebab-case-filenames",
    {
      "src/FooBar.ts": "",
      "src/foo-bar.ts": "",
      "src/index.ts": "",
      "src/useThing.tsx": "",
      "README.md": "",
    },
    {}
  );
  assert.deepEqual(
    found.map((v) => `${v.file}:${v.line}`),
    ["src/FooBar.ts:0", "src/useThing.tsx:0"]
  );
  assert.equal(found[0]?.message, 'File name "FooBar.ts" must use kebab-case');
});

test("kebab: layer option limits the roots", async () => {
  const files = [
    "services/a/src/Foo.ts",
    "packages/b/src/Bar.tsx",
    "apps/web/src/Baz.tsx",
    "services/a/src/ok.ts",
  ];
  const options = { layer: "source" };
  const config = { layers: { source: ["{services,packages}/*/src/**"] } };
  assert.deepEqual(await kebab(files, { options, config }), [
    "packages/b/src/Bar.tsx",
    "services/a/src/Foo.ts",
  ]);
  assert.deepEqual(await kebab(files), [
    "apps/web/src/Baz.tsx",
    "packages/b/src/Bar.tsx",
    "services/a/src/Foo.ts",
  ]);
});

test("kebab: include roots, exempt dirs, skipTests and skipDeclarations", async () => {
  const files = [
    "lib/UserCard.tsx",
    "lib/intl/Messages.ts",
    "lib/Helper.test.ts",
    "lib/Types.d.ts",
    "scripts/Build.ts",
    "proxy.ts",
    "app/Page.tsx",
  ];
  const settings = {
    include: [
      "app/",
      "components/",
      "lib/",
      "store/",
      "types/",
      "hooks/",
      "proxy.ts",
    ],
    exempt: { dirs: ["lib/intl/"] },
  };
  const scoped = await kebab(files, {
    settings,
    options: { skipTests: true, skipDeclarations: true },
  });
  assert.deepEqual(scoped, ["app/Page.tsx", "lib/UserCard.tsx"]);

  const everything = await kebab(files, { settings });
  assert.deepEqual(everything, [
    "app/Page.tsx",
    "lib/Helper.test.ts",
    "lib/Types.d.ts",
    "lib/UserCard.tsx",
  ]);
});

test("kebab: extensions and message are options", async () => {
  assert.deepEqual(
    await kebab(["a/Mod.mjs", "a/Mod.ts"], {
      options: { extensions: [".mjs"] },
    }),
    ["a/Mod.mjs"]
  );
  const found = await checkProject(
    "kebab-case-filenames",
    { "a/Mod.ts": "" },
    { options: { message: "Rename it." } }
  );
  assert.equal(found[0]?.message, "Rename it.");
});

const naming = async (
  files: string[],
  opts: Parameters<typeof checkProject>[2] = {}
): Promise<string[]> =>
  (
    await checkProject(
      "test-file-naming",
      Object.fromEntries(files.map((f) => [f, ""])),
      opts
    )
  )
    .map((v) => v.file)
    .sort();

test("test-file-naming: accepts every default suffix and flags the rest", async () => {
  const good = [
    "a.unit.test.ts",
    "a.fn.test.ts",
    "a.integration.test.ts",
    "a.load.test.ts",
    "a.contract.test.ts",
    "a.e2e.test.ts",
    "a.performance.test.ts",
  ].map((f) => `services/x/tests/${f}`);
  assert.deepEqual(await naming(good), []);
  assert.deepEqual(
    await naming([
      ...good,
      "services/x/tests/plain.test.ts",
      "services/x/tests/a.spec.test.ts",
    ]),
    ["services/x/tests/a.spec.test.ts", "services/x/tests/plain.test.ts"]
  );
});

test("test-file-naming: reports line 0 and lists the accepted suffixes", async () => {
  const found = await checkProject("test-file-naming", {
    "tests/plain.test.ts": "",
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, 0);
  assert.match(found[0]?.message ?? "", /\.unit\.test\.ts/);
  assert.match(found[0]?.message ?? "", /\.contract\.test\.ts/);
});

test("test-file-naming: setup directories are skipped and the skip list is an option", async () => {
  const files = [
    "services/x/tests/setup/preload.test.ts",
    "services/x/tests/plain.test.ts",
  ];
  assert.deepEqual(await naming(files), ["services/x/tests/plain.test.ts"]);
  assert.deepEqual(
    await naming(files, { options: { skipPathParts: [] } }),
    files.slice().sort()
  );
});

test("test-file-naming: test directories come from the config test patterns or the patterns option", async () => {
  const files = [
    "services/x/tests/a.test.ts",
    "services/x/src/b.test.ts",
    "services/x/src/c.ts",
  ];
  assert.deepEqual(await naming(files), [
    "services/x/src/b.test.ts",
    "services/x/tests/a.test.ts",
  ]);
  assert.deepEqual(
    await naming(files, { config: { tests: ["**/tests/**"] } }),
    ["services/x/tests/a.test.ts"]
  );
  assert.deepEqual(
    await naming(files, { options: { patterns: ["services/*/src/**"] } }),
    ["services/x/src/b.test.ts"]
  );
  assert.deepEqual(
    await naming(files, { settings: { include: ["services/*/tests/**"] } }),
    ["services/x/tests/a.test.ts"]
  );
});

test("test-file-naming: suffix list and checked file endings are options", async () => {
  const files = ["tests/a.spec.ts", "tests/b.unit.spec.ts", "tests/c.test.tsx"];
  const options = {
    suffixes: [".unit.spec.ts"],
    testFileSuffixes: [".spec.ts", ".test.tsx"],
  };
  assert.deepEqual(await naming(files, { options }), [
    "tests/a.spec.ts",
    "tests/c.test.tsx",
  ]);
  assert.deepEqual(await naming(files), []);
  assert.deepEqual(
    await naming(["tests/a.test.ts"], {
      settings: { exempt: { files: ["tests/a.test.ts"] } },
    }),
    []
  );
});

const pkg = (testScript: string | null) =>
  JSON.stringify({
    name: "p",
    scripts: testScript === null ? {} : { test: testScript },
  });

const wholeDir = (
  files: Record<string, string>,
  opts: Parameters<typeof checkProject>[2] = {}
) => checkProject("no-whole-dir-test-script", files, opts);

test("whole-dir helper: accepts one file per call, with flags in either form", () => {
  const script =
    "bun test --timeout=30000 --env-file=../../.env.test tests/a.test.ts && bun test --timeout 5000 tests/b.test.ts";
  assert.equal(findWholeDirTarget(script), null);
});

test("whole-dir helper: flags a directory, a bare call and a bare flag-only call", () => {
  assert.equal(findWholeDirTarget("bun test tests"), '"tests"');
  assert.notEqual(findWholeDirTarget("bun test"), null);
  assert.notEqual(findWholeDirTarget("bun test --bail"), null);
});

test("whole-dir helper: flags a boolean flag hiding a directory and several files in one call", () => {
  assert.equal(findWholeDirTarget("bun test --coverage tests"), '"tests"');
  assert.equal(
    findWholeDirTarget("bun test a.test.ts b.test.ts"),
    "2 files together"
  );
});

test("whole-dir helper: checks segments joined with ; or ||", () => {
  assert.equal(
    findWholeDirTarget("bun test a.test.ts; bun test tests"),
    '"tests"'
  );
  assert.notEqual(findWholeDirTarget("bun test a.test.ts || bun test"), null);
});

test("whole-dir helper: basic variant reads && only and flags the first non-file argument", () => {
  const basic = { variant: "basic" as const, testFileSuffixes: [".test.ts"] };
  assert.equal(findWholeDirTarget("bun test tests/", basic), '"tests/"');
  assert.equal(findWholeDirTarget("bun test", basic), null);
  assert.equal(findWholeDirTarget("bun test a.test.ts b.test.ts", basic), null);
  assert.equal(
    findWholeDirTarget("bun test a.test.ts && bun test tests/unit", basic),
    '"tests/unit"'
  );
  assert.equal(
    findWholeDirTarget("bun test --timeout 5000 a.test.ts", basic),
    '"5000"'
  );
  assert.equal(
    findWholeDirTarget("bun test a.test.tsx", basic),
    '"a.test.tsx"'
  );
  assert.equal(
    findWholeDirTarget("bun test a.test.ts || bun test tests", basic),
    '"||"'
  );
});

test("whole-dir helper: command is an option", () => {
  assert.equal(
    findWholeDirTarget("vitest run src", { command: "vitest run" }),
    '"src"'
  );
  assert.equal(
    findWholeDirTarget("bun test src", { command: "vitest run" }),
    null
  );
});

test("whole-dir: flags a package whose suite uses mock.module and runs a directory", async () => {
  const found = await wholeDir({
    "packages/a/package.json": pkg("bun test tests"),
    "packages/a/tests/x.test.ts": 'mock.module("fs", () => ({}));',
  });
  assert.equal(found.length, 1);
  assert.equal(found[0]?.file, "packages/a/package.json");
  assert.equal(found[0]?.line, 0);
  assert.equal(found[0]?.rule, "no-whole-dir-test-script");
  assert.match(found[0]?.message ?? "", /"tests"/);
  assert.match(found[0]?.message ?? "", /mock\.module/);
});

test("whole-dir: packages without the marker, other packages' tests and missing scripts are left alone", async () => {
  const found = await wholeDir({
    "packages/a/package.json": pkg("bun test tests"),
    "packages/a/tests/x.test.ts": "expect(1).toBe(1);",
    "packages/b/package.json": pkg("bun test tests"),
    "packages/c/tests/y.test.ts": 'mock.module("fs", () => ({}));',
    "packages/d/package.json": pkg(null),
    "packages/d/tests/z.test.ts": 'mock.module("fs", () => ({}));',
    "packages/e/package.json": "{ not json",
    "packages/e/tests/z.test.ts": 'mock.module("fs", () => ({}));',
    "packages/f/package.json": pkg("bun test a.test.ts && bun test b.test.ts"),
    "packages/f/a.test.ts": 'mock.module("fs", () => ({}));',
  });
  assert.deepEqual(found, []);
});

test("whole-dir: a grandfather list is an exemption on the manifest", async () => {
  const files = {
    "packages/db/package.json": pkg("bun test tests"),
    "packages/db/tests/x.test.ts": "mock.module('x')",
    "packages/new/package.json": pkg("bun test tests"),
    "packages/new/tests/x.test.ts": "mock.module('x')",
  };
  const found = await wholeDir(files, {
    settings: { exempt: { files: ["packages/db/package.json"] } },
  });
  assert.deepEqual(
    found.map((v) => v.file),
    ["packages/new/package.json"]
  );
});

test("whole-dir: manifests option limits which package.json files are read", async () => {
  const files = {
    "services/a/package.json": pkg("bun test tests"),
    "services/a/tests/x.test.ts": "mock.module('x')",
    "apps/web/package.json": pkg("bun test tests"),
    "apps/web/tests/x.test.ts": "mock.module('x')",
  };
  assert.equal((await wholeDir(files)).length, 2);
  const only = await wholeDir(files, {
    options: { manifests: ["{services,packages,plugins}/*/package.json"] },
  });
  assert.deepEqual(
    only.map((v) => v.file),
    ["services/a/package.json"]
  );
});

test("whole-dir: the root package is checked against every test file under it", async () => {
  const found = await wholeDir({
    "package.json": pkg("bun test"),
    "src/x.test.ts": "mock.module('x')",
  });
  assert.deepEqual(
    found.map((v) => v.file),
    ["package.json"]
  );
  assert.match(found[0]?.message ?? "", /every test file in the package/);
});

test("whole-dir: basic variant with the narrower manifests and test suffixes", async () => {
  const options = {
    variant: "basic",
    manifests: ["{services,packages,plugins}/*/package.json"],
    testFileSuffixes: [".test.ts"],
  };
  const files = {
    "services/a/package.json": pkg("bun test --timeout 5000 tests/a.test.ts"),
    "services/a/tests/a.test.ts": "mock.module('x')",
    "services/b/package.json": pkg("bun test"),
    "services/b/tests/a.test.ts": "mock.module('x')",
    "services/c/package.json": pkg("bun test tests/"),
    "services/c/tests/a.test.tsx": "mock.module('x')",
    "services/d/package.json": pkg("bun test tests/"),
    "services/d/tests/a.test.ts": "mock.module('x')",
  };
  const basic = await wholeDir(files, { options });
  assert.deepEqual(
    basic.map((v) => v.file),
    ["services/a/package.json", "services/d/package.json"]
  );

  const strict = await wholeDir(files, {
    options: { manifests: options.manifests },
  });
  assert.deepEqual(
    strict.map((v) => v.file),
    [
      "services/b/package.json",
      "services/c/package.json",
      "services/d/package.json",
    ]
  );
});

test("whole-dir: script, marker and command are options", async () => {
  const files = {
    "p/package.json": JSON.stringify({
      scripts: { "test:unit": "vitest run src", test: "ok" },
    }),
    "p/src/x.test.ts": "vi.mock('x')",
  };
  const base = {
    script: "test:unit",
    command: "vitest run",
    marker: "vi.mock",
  };
  const found = await wholeDir(files, { options: base });
  assert.equal(found.length, 1);
  assert.match(found[0]?.message ?? "", /"test:unit"/);
  assert.match(found[0]?.message ?? "", /vi\.mock/);

  assert.equal(
    (await wholeDir(files, { options: { ...base, marker: "mock.module" } }))
      .length,
    0
  );
  assert.equal(
    (await wholeDir(files, { options: { ...base, marker: "" } })).length,
    1
  );
  assert.equal(
    (await wholeDir(files, { options: { ...base, script: "test" } })).length,
    0
  );
});

test("whole-dir: valueFlags and message are options", async () => {
  const files = {
    "p/package.json": pkg("bun test --shard 1 p.test.ts"),
    "p/p.test.ts": "mock.module('x')",
  };
  assert.equal((await wholeDir(files)).length, 1);
  assert.equal(
    (await wholeDir(files, { options: { valueFlags: ["--shard"] } })).length,
    0
  );
  const custom = await wholeDir(files, {
    options: { message: "Split the script." },
  });
  assert.equal(custom[0]?.message, "Split the script.");
});
