import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import * as prettier from "prettier";
import {
  loadBiomeCompat,
  mapBiomeConfig,
  parseJsonc,
} from "../src/configs/biome-compat.mjs";
import { createConfig as createEslintConfig } from "../src/configs/eslint.config.mjs";
import { createConfig as createPrettierConfig } from "../src/configs/prettier.config.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/bin.mjs");
const fixtures = path.join(root, "tests/fixtures/biome");
const organizeImports = fileURLToPath(
  import.meta.resolve("prettier-plugin-organize-imports")
);

async function fixture(name) {
  return parseJsonc(await readFile(path.join(fixtures, name), "utf8"));
}

const messages = (result, area) =>
  result.notes
    .filter((note) => !area || note.area === area)
    .map((note) => note.message);

const map = (config) => mapBiomeConfig(config);

async function arch(cwd, ...args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, "--cwd", cwd, ...args],
      { maxBuffer: 1 << 28 }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function withProject(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "arch-lint-biome-"));
  try {
    await writeFile(
      path.join(dir, "package.json"),
      '{\n  "name": "fx",\n  "version": "1.0.0"\n}\n'
    );
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const json = (value) => `${JSON.stringify(value)}\n`;

test("parseJsonc drops comments and trailing commas but keeps string contents", () => {
  const text = `${String.fromCharCode(0xfeff)}// lead
  {
    "url": "https://example.com/a,b", /* inline */
    "list": [1, 2, /* last */ ],
    "path": "a//b/*c*/",
    "nested": { "k": "v", },
  }`;
  assert.deepEqual(parseJsonc(text), {
    url: "https://example.com/a,b",
    list: [1, 2],
    path: "a//b/*c*/",
    nested: { k: "v" },
  });
});

test("the 1.x minimal config maps ignores, two rules and the formatter", async () => {
  const result = map(await fixture("v1-minimal.json"));
  assert.equal(result.prettier.printWidth, 100);
  assert.equal(result.prettier.useTabs, false);
  assert.equal(result.prettier.tabWidth, 2);
  assert.equal(result.organizeImports, true);
  assert.deepEqual(result.eslint.rules, {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/no-non-null-assertion": "warn",
  });
  assert.deepEqual(result.eslint.overrides, []);
  for (const glob of [
    "dist",
    "dist/**",
    "**/.next",
    "apps/nlp/**",
    ".claude",
  ]) {
    assert.ok(result.eslint.ignores.includes(glob), glob);
  }
  assert.deepEqual(result.prettierIgnore.slice(0, 3), [
    "node_modules",
    "dist",
    ".turbo",
  ]);
  assert.deepEqual(messages(result, "linter"), []);
});

test("the full 2.x config maps rules, overrides and the es5 comma style", async () => {
  const result = map(await fixture("v2-full.json"));
  assert.equal(result.prettier.printWidth, 100);
  assert.equal(result.prettier.trailingComma, "es5");
  assert.equal(result.prettier.semi, true);
  assert.equal(result.prettier.singleQuote, false);
  assert.deepEqual(result.eslint.rules, {
    "prefer-const": "error",
    "prefer-template": "error",
    "@typescript-eslint/no-non-null-assertion": "warn",
    "@typescript-eslint/no-explicit-any": "error",
    "no-console": "warn",
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        destructuredArrayIgnorePattern: "^_",
        ignoreRestSiblings: true,
        args: "none",
      },
    ],
  });
  assert.deepEqual(
    result.eslint.overrides.map((block) => block.files),
    [
      ["**/tools/**", "**/packages/db/src/seed.ts", "**/seed.ts"],
      ["**/tests/**", "**/*.test.ts"],
      ["**/tools/asset-pipeline/**"],
    ]
  );
  assert.deepEqual(result.eslint.overrides[1].rules, {
    "@typescript-eslint/no-non-null-assertion": "off",
    "no-console": "off",
    "@typescript-eslint/no-explicit-any": "warn",
  });
  assert.ok(result.eslint.ignores.includes("**/*.css"));
  assert.ok(result.eslint.ignores.includes("**/dist/**"));
  assert.ok(result.eslint.ignores.includes("**/*.generated.ts"));
  assert.ok(result.prettierIgnore.includes("**/*.css"));
  assert.ok(result.prettierIgnore.includes("**/tools/asset-pipeline/bin"));
  const linterNotes = messages(result, "linter");
  assert.equal(linterNotes.length, 1);
  assert.match(linterNotes[0], /nursery\.useSortedClasses.*tailwindcss/);
});

test("the preset form of the 2.x config reads like the recommended boolean", async () => {
  const result = map(await fixture("v2-preset.json"));
  assert.equal(result.eslint.rules["prefer-const"], "error");
  assert.equal(result.eslint.rules["no-console"], "warn");
  assert.equal(result.eslint.overrides.length, 1);
  assert.deepEqual(messages(result, "linter"), []);
  assert.ok(result.prettierIgnore.includes("**/apps/mobile"));
});

test("a formatter-only config fills the rest with Biome defaults", async () => {
  const result = map(await fixture("v2-formatter-only.json"));
  assert.deepEqual(result.prettier, {
    useTabs: false,
    tabWidth: 2,
    printWidth: 100,
    endOfLine: "lf",
    singleQuote: false,
    jsxSingleQuote: false,
    quoteProps: "as-needed",
    trailingComma: "all",
    semi: true,
    arrowParens: "always",
    bracketSpacing: true,
    bracketSameLine: false,
    singleAttributePerLine: false,
    objectWrap: "preserve",
    experimentalOperatorPosition: "end",
  });
  assert.deepEqual(result.eslint.rules, {});
  assert.deepEqual(result.eslint.ignores, ["**/drizzle", "**/drizzle/**"]);
  assert.deepEqual(result.prettierIgnore, ["**/drizzle"]);
});

test("a commented config maps every formatter option with a Prettier equivalent", async () => {
  const result = map(await fixture("v2-comments.jsonc"));
  assert.deepEqual(result.prettier, {
    useTabs: true,
    tabWidth: 4,
    printWidth: 120,
    endOfLine: "lf",
    singleQuote: true,
    jsxSingleQuote: true,
    quoteProps: "preserve",
    trailingComma: "none",
    semi: false,
    arrowParens: "avoid",
    bracketSpacing: false,
    bracketSameLine: true,
    singleAttributePerLine: true,
    objectWrap: "collapse",
    experimentalOperatorPosition: "start",
  });
  assert.deepEqual(result.eslint.rules["no-console"], [
    "error",
    { allow: ["error", "warn"] },
  ]);
  assert.deepEqual(result.eslint.rules.eqeqeq, [
    "warn",
    "always",
    { null: "ignore" },
  ]);
  assert.ok(result.eslint.ignores.includes("scripts/**"));
  assert.ok(result.prettierIgnore.includes("legacy"));
  assert.ok(result.eslint.ignores.includes("**/*.snap"));
});

test("levels map to ESLint levels and unmapped rules are reported, not dropped", () => {
  const result = map({
    linter: {
      rules: {
        suspicious: {
          noConsole: "on",
          noDebugger: "info",
          noVar: "off",
          noExplicitAny: { level: "error" },
          noDoubleEquals: { level: "error", options: { ignoreNull: false } },
        },
        style: { useBlockStatements: "warn", noParameterAssign: "error" },
        a11y: { useAltText: "error", noAutofocus: "off" },
      },
    },
  });
  assert.deepEqual(result.eslint.rules, {
    "no-console": "warn",
    "no-debugger": "warn",
    "no-var": "off",
    "@typescript-eslint/no-explicit-any": "error",
    eqeqeq: ["error", "always"],
    curly: ["warn", "all"],
    "no-param-reassign": "error",
  });
  const notes = messages(result, "linter");
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^a11y\.useAltText:/);
});

test("unused imports and unused variables share one rule at the stricter level", () => {
  const both = map({
    linter: {
      rules: {
        correctness: { noUnusedImports: "warn", noUnusedVariables: "error" },
      },
    },
  });
  assert.equal(
    both.eslint.rules["@typescript-eslint/no-unused-vars"][0],
    "error"
  );
  assert.match(messages(both, "linter")[0], /share one ESLint rule.*error/);

  const single = map({
    linter: { rules: { correctness: { noUnusedImports: "warn" } } },
  });
  assert.equal(
    single.eslint.rules["@typescript-eslint/no-unused-vars"][0],
    "warn"
  );
  assert.equal(messages(single, "linter").length, 1);

  const off = map({
    linter: {
      rules: {
        correctness: { noUnusedImports: "off", noUnusedVariables: "off" },
      },
    },
  });
  assert.equal(off.eslint.rules["@typescript-eslint/no-unused-vars"], "off");
  assert.equal(off.eslint.rules["no-unused-vars"], "off");
  assert.deepEqual(messages(off, "linter"), []);
});

const unusedOptions = (config) =>
  map({ linter: { rules: { correctness: config } } }).eslint.rules[
    "@typescript-eslint/no-unused-vars"
  ][1];

test("unused variables leave function parameters alone unless noUnusedFunctionParameters is on", () => {
  assert.equal(unusedOptions({ noUnusedVariables: "warn" }).args, "none");
  assert.equal(
    unusedOptions({
      noUnusedVariables: "warn",
      noUnusedFunctionParameters: "off",
    }).args,
    "none"
  );
  for (const level of ["warn", "error", { level: "warn" }]) {
    const options = unusedOptions({
      noUnusedVariables: "warn",
      noUnusedFunctionParameters: level,
    });
    assert.equal(options.args, "after-used");
    assert.equal(options.argsIgnorePattern, "^_");
  }
  assert.equal(unusedOptions({ noUnusedImports: "warn" }).args, "none");
});

test("noUnusedFunctionParameters alone adds no rule and is reported", () => {
  const alone = map({
    linter: { rules: { correctness: { noUnusedFunctionParameters: "warn" } } },
  });
  assert.deepEqual(alone.eslint.rules, {});
  assert.match(
    messages(alone, "linter")[0],
    /noUnusedFunctionParameters: .*noUnusedVariables/
  );
  const off = map({
    linter: { rules: { correctness: { noUnusedFunctionParameters: "off" } } },
  });
  assert.deepEqual(messages(off, "linter"), []);
});

test("a switched-off recommended set and group-level settings are reported", () => {
  const result = map({
    linter: { rules: { recommended: false, style: "off" } },
  });
  assert.equal(messages(result, "linter").length, 2);
  const disabled = map({
    linter: { enabled: false, rules: { style: { useConst: "error" } } },
  });
  assert.deepEqual(disabled.eslint.rules, {});
  assert.match(messages(disabled, "linter")[0], /linter\.enabled is false/);
});

test("1.x overrides use include and ignore, and a missing include skips the override", () => {
  const result = map({
    overrides: [
      {
        include: ["src/legacy"],
        ignore: ["src/legacy/keep.ts"],
        linter: { rules: { suspicious: { noConsole: "off" } } },
      },
      { linter: { rules: { suspicious: { noConsole: "off" } } } },
    ],
  });
  assert.deepEqual(result.eslint.overrides, [
    {
      files: ["src/legacy", "src/legacy/**"],
      ignores: ["src/legacy/keep.ts"],
      rules: { "no-console": "off" },
    },
  ]);
  assert.match(
    messages(result, "files")[0],
    /overrides\[1\]: no include patterns/
  );
});

test("an override that switches a tool off becomes an ignore", () => {
  const result = map({
    overrides: [
      {
        includes: ["generated/**"],
        linter: { enabled: false },
        formatter: { enabled: false },
      },
    ],
  });
  assert.deepEqual(result.eslint.ignores, ["generated/**"]);
  assert.deepEqual(result.prettierIgnore, ["generated/**"]);
  assert.deepEqual(result.eslint.overrides, []);
});

test("per-path formatter options and include patterns that narrow the file set are reported", () => {
  const result = map({
    files: { includes: ["src/**", "!src/gen"] },
    overrides: [{ includes: ["tests/**"], formatter: { lineWidth: 120 } }],
  });
  const all = messages(result);
  assert.ok(
    all.some((text) => /^files: include patterns that narrow/.test(text))
  );
  assert.ok(
    all.some((text) => /^overrides\[0\]: per-path formatter options/.test(text))
  );
  assert.deepEqual(result.prettierIgnore, ["src/gen"]);
});

test("formatter values with no Prettier equivalent are reported and the default stays", () => {
  const result = map({
    formatter: { expand: "always", lineEnding: "weird", lineWidth: "wide" },
    javascript: { formatter: { trailingComma: "es5" } },
  });
  assert.equal(result.prettier.objectWrap, "preserve");
  assert.equal(result.prettier.endOfLine, "lf");
  assert.equal(result.prettier.printWidth, 80);
  assert.equal(result.prettier.trailingComma, "es5");
  assert.equal(
    messages(result, "formatter").filter((text) => /^formatter\./.test(text))
      .length,
    3
  );
});

test("a disabled formatter keeps the bundled Prettier defaults", () => {
  const result = map({ formatter: { enabled: false, lineWidth: 120 } });
  assert.deepEqual(result.prettier, {});
  assert.equal(result.organizeImports, true);
  assert.match(messages(result, "formatter")[0], /formatter\.enabled is false/);
});

test("organize imports follows the 1.x and 2.x switches", () => {
  assert.equal(map({}).organizeImports, true);
  assert.equal(
    map({ organizeImports: { enabled: false } }).organizeImports,
    false
  );
  assert.equal(
    map({ assist: { actions: { source: { organizeImports: "off" } } } })
      .organizeImports,
    false
  );
  assert.equal(map({ assist: { enabled: false } }).organizeImports, false);
});

test("unsupported sections are listed by name", () => {
  const all = messages(
    map({
      extends: ["./base.json"],
      css: {},
      javascript: { globals: ["Deno"] },
    })
  );
  assert.ok(all.some((text) => text.startsWith("extends:")));
  assert.ok(all.some((text) => text.startsWith("css:")));
  assert.ok(all.some((text) => text.startsWith("javascript.globals:")));
});

test("vcs.useIgnoreFile turns .gitignore lines into ESLint ignores", async () => {
  await withProject(
    {
      "biome.json": json({ vcs: { enabled: true, useIgnoreFile: true } }),
      ".gitignore": "# build\ndist/\n/out\n*.log\nsrc/gen/\n!keep.log\n",
    },
    async (dir) => {
      const result = loadBiomeCompat(dir);
      assert.deepEqual(result.eslint.ignores, [
        "**/dist",
        "out",
        "**/*.log",
        "src/gen",
      ]);
      assert.match(messages(result, "linter")[0], /negated line "!keep\.log"/);
    }
  );
  await withProject(
    {
      "biome.json": json({ vcs: { enabled: true, useIgnoreFile: false } }),
      ".gitignore": "dist/\n",
    },
    async (dir) => {
      assert.deepEqual(loadBiomeCompat(dir).eslint.ignores, []);
    }
  );
});

test("loadBiomeCompat reads biome.jsonc and reports a broken file by name", async () => {
  await withProject(
    { "biome.jsonc": '// note\n{ "formatter": { "lineWidth": 90, }, }\n' },
    async (dir) => {
      const result = loadBiomeCompat(dir);
      assert.equal(result.file, "biome.jsonc");
      assert.equal(result.prettier.printWidth, 90);
    }
  );
  await withProject({ "biome.json": "{ nope" }, async (dir) => {
    assert.throws(() => loadBiomeCompat(dir), /^Error: biome\.json:/);
    const result = await arch(dir, "lint");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /arch-lint: biome\.json:/);
  });
  await withProject({}, async (dir) => {
    assert.equal(loadBiomeCompat(dir), null);
  });
});

const SOURCE = `const greeting   = "hello world"
export function build(first: string, second: number, third: boolean, fourth: string): string {
  return greeting + first + second + third + fourth
}
export const total = compute(alphaAlphaAlpha, betaBetaBeta, gammaGammaGamma, deltaDeltaDelta, epsilon)
`;

test("format:write on a Biome project produces Prettier output for the mapped options", async () => {
  const biome = {
    formatter: { indentStyle: "space", indentWidth: 2, lineWidth: 100 },
    javascript: { formatter: { quoteStyle: "single", semicolons: "asNeeded" } },
  };
  const expected = await prettier.format(SOURCE, {
    parser: "typescript",
    printWidth: 100,
    tabWidth: 2,
    useTabs: false,
    singleQuote: true,
    semi: false,
    trailingComma: "all",
    plugins: [organizeImports],
  });
  const fallback = await prettier.format(SOURCE, {
    parser: "typescript",
    plugins: [organizeImports],
  });
  assert.notEqual(expected, fallback);

  await withProject(
    { "biome.json": json(biome), "src/a.ts": SOURCE },
    async (dir) => {
      assert.equal((await arch(dir, "format", "src")).code, 1);
      const written = await arch(dir, "format:write", "src");
      assert.equal(written.code, 0, written.stderr);
      assert.equal(
        await readFile(path.join(dir, "src/a.ts"), "utf8"),
        expected
      );
      assert.equal((await arch(dir, "format", "src")).code, 0);
    }
  );
});

test("Biome ignore patterns keep Prettier away from files, even ones named directly", async () => {
  const biome = {
    files: { includes: ["**", "!**/generated", "!apps/legacy"] },
    overrides: [{ includes: ["frozen/**"], formatter: { enabled: false } }],
  };
  const messy = "export const a   = { b:1 }\n";
  await withProject(
    {
      "biome.json": json(biome),
      "src/generated/a.ts": messy,
      "apps/legacy/b.ts": messy,
      "frozen/c.ts": messy,
      "packages/apps/legacy/d.ts": messy,
    },
    async (dir) => {
      const result = await arch(
        dir,
        "format",
        "src",
        "apps",
        "frozen",
        "packages"
      );
      assert.equal(result.code, 1);
      assert.match(
        result.stderr + result.stdout,
        /packages\/apps\/legacy\/d\.ts/
      );
      assert.doesNotMatch(
        result.stderr + result.stdout,
        /generated|apps\/legacy\/b|frozen/
      );
      const named = await arch(
        dir,
        "format",
        "src/generated/a.ts",
        "frozen/c.ts"
      );
      assert.equal(named.code, 0, named.stderr + named.stdout);
    }
  );
});

const CONSOLE_SOURCE = 'console.log("x");\n';

test("lint reports no-console at the level the config sets and honours an override", async () => {
  const files = {
    "src/a.ts": CONSOLE_SOURCE,
    "tests/b.ts": CONSOLE_SOURCE,
  };
  const overrides = [
    {
      includes: ["**/tests/**"],
      linter: { rules: { suspicious: { noConsole: "off" } } },
    },
  ];
  const config = (level) => ({
    linter: { rules: { suspicious: { noConsole: level } } },
    overrides,
  });

  await withProject(
    { ...files, "biome.json": json(config("warn")) },
    async (dir) => {
      const result = await arch(dir, "lint");
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, /src\/a\.ts/);
      assert.match(
        result.stdout,
        /warning\s+Unexpected console statement\s+no-console/
      );
      assert.doesNotMatch(result.stdout, /tests\/b\.ts/);
    }
  );
  await withProject(
    { ...files, "biome.json": json(config("error")) },
    async (dir) => {
      const result = await arch(dir, "lint");
      assert.equal(result.code, 1);
      assert.match(
        result.stdout,
        /error\s+Unexpected console statement\s+no-console/
      );
      assert.doesNotMatch(result.stdout, /tests\/b\.ts/);
    }
  );
});

test("lint follows the Biome level and underscore rule for unused variables", async () => {
  const biome = {
    linter: { rules: { correctness: { noUnusedVariables: "warn" } } },
  };
  await withProject(
    {
      "biome.json": json(biome),
      "src/a.ts":
        "const unused = 1;\nconst _skipped = 2;\nexport const a = 3;\n",
    },
    async (dir) => {
      const result = await arch(dir, "lint");
      assert.equal(result.code, 0, result.stdout);
      assert.match(
        result.stdout,
        /warning\s+'unused' is assigned a value but never used/
      );
      assert.doesNotMatch(result.stdout, /_skipped/);
    }
  );
});

test("lint does not flag unused function parameters unless Biome's parameter rule is on", async () => {
  const source = "export function f(a: number, b: number) {\n  return a;\n}\n";
  const rules = (correctness) => ({ linter: { rules: { correctness } } });
  await withProject(
    {
      "biome.json": json(rules({ noUnusedVariables: "error" })),
      "src/a.ts": source,
    },
    async (dir) => {
      const result = await arch(dir, "lint");
      assert.equal(result.code, 0, result.stdout);
    }
  );
  await withProject(
    {
      "biome.json": json(
        rules({
          noUnusedVariables: "error",
          noUnusedFunctionParameters: "error",
        })
      ),
      "src/a.ts": source,
    },
    async (dir) => {
      const result = await arch(dir, "lint");
      assert.equal(result.code, 1);
      assert.match(result.stdout, /'b' is defined but never used/);
    }
  );
});

test("Biome ignores and .gitignore reach ESLint", async () => {
  await withProject(
    {
      "biome.json": json({
        vcs: { enabled: true, useIgnoreFile: true },
        files: { includes: ["**", "!**/generated"] },
      }),
      ".gitignore": "scratch/\n",
      "src/generated/a.ts": "var a = 1;\n",
      "scratch/b.ts": "var b = 1;\n",
      "src/c.ts": "export const c = 1;\n",
    },
    async (dir) => {
      const result = await arch(dir, "lint");
      assert.equal(result.code, 0, result.stdout);
    }
  );
});

test("notes print once on stderr, split by tool, and check does not repeat them", async () => {
  const biome = {
    linter: { rules: { nursery: { useSortedClasses: "warn" } } },
    files: { includes: ["**", "!**/generated"] },
  };
  await withProject(
    { "biome.json": json(biome), "src/a.ts": "export const a = 1;\n" },
    async (dir) => {
      const linted = await arch(dir, "lint");
      assert.equal(linted.stderr.match(/useSortedClasses/g).length, 1);
      assert.doesNotMatch(linted.stderr, /organizeImports/);

      const checked = await arch(dir, "check", "--skip-arch");
      assert.equal(checked.stderr.match(/useSortedClasses/g).length, 1);
      assert.equal(checked.stderr.match(/organizeImports/g).length, 1);
    }
  );
});

test("a project without biome.json keeps the old defaults and prints no notes", async () => {
  await withProject(
    { "src/a.ts": "const a   = 'x'\nexport { a }\n" },
    async (dir) => {
      const written = await arch(dir, "format:write", "src");
      assert.equal(written.code, 0);
      assert.equal(written.stderr, "");
      assert.equal(
        await readFile(path.join(dir, "src/a.ts"), "utf8"),
        'const a = "x";\nexport { a };\n'
      );
    }
  );
  await withProject({ "src/a.ts": CONSOLE_SOURCE }, async (dir) => {
    const result = await arch(dir, "lint");
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /no-console/);
  });
});

test("a project's own ESLint or Prettier config keeps biome.json out of that tool", async () => {
  const biome = {
    formatter: { lineWidth: 100 },
    javascript: { formatter: { quoteStyle: "single", semicolons: "asNeeded" } },
    linter: { rules: { suspicious: { noConsole: "error" } } },
  };
  await withProject(
    {
      "biome.json": json(biome),
      "eslint.config.mjs": "export default [{ rules: {} }];\n",
      ".prettierrc.json": "{}\n",
      "src/a.ts": 'console.log("x");\n',
    },
    async (dir) => {
      const linted = await arch(dir, "lint");
      assert.equal(linted.code, 0, linted.stdout);
      assert.equal(linted.stderr, "");
      const formatted = await arch(dir, "format", "src");
      assert.equal(formatted.code, 0, formatted.stdout + formatted.stderr);
      assert.equal(formatted.stderr.includes("biome"), false);
    }
  );
});

test("createConfig takes biome.json whenever one exists, unless biome is false", async () => {
  const files = {
    "biome.json": json({
      formatter: { lineWidth: 100 },
      files: { includes: ["**", "!**/generated"] },
    }),
    "eslint.config.mjs": "export default [];\n",
    ".prettierrc.json": "{}\n",
  };
  await withProject(files, async (dir) => {
    for (const options of [{}, { biome: "auto" }, { biome: true }]) {
      const config = await createEslintConfig({ root: dir, ...options });
      assert.ok(config[0].ignores.includes("**/generated"));
      assert.equal(
        createPrettierConfig({ root: dir, ...options }).printWidth,
        100
      );
    }
    const off = await createEslintConfig({ root: dir, biome: false });
    assert.equal(off[0].ignores.includes("**/generated"), false);
    assert.equal(
      createPrettierConfig({ root: dir, biome: false }).printWidth,
      80
    );
  });
  await withProject({}, async (dir) => {
    assert.equal(createPrettierConfig({ root: dir }).printWidth, 80);
  });
});

async function linkPackage(dir) {
  await mkdir(path.join(dir, "node_modules"), { recursive: true });
  await symlink(root, path.join(dir, "node_modules/arch-lint"));
}

const WRAP_ESLINT = (options) =>
  `import { createConfig } from "arch-lint/eslint";\nexport default await createConfig(${options});\n`;
const WRAP_PRETTIER = (options) =>
  `import { createConfig } from "arch-lint/prettier";\nexport default createConfig(${options});\n`;

test("a project ESLint config that wraps createConfig gets the Biome rules, ignores and notes", async () => {
  const biome = {
    files: { includes: ["**", "!**/generated"] },
    linter: {
      rules: {
        suspicious: { noConsole: "error" },
        nursery: { useSortedClasses: "warn" },
      },
    },
  };
  const files = {
    "biome.json": json(biome),
    "eslint.config.mjs": WRAP_ESLINT("{}"),
    "src/a.ts": CONSOLE_SOURCE,
    "src/generated/b.ts": CONSOLE_SOURCE,
  };
  await withProject(files, async (dir) => {
    await linkPackage(dir);
    const result = await arch(dir, "lint");
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /src\/a\.ts/);
    assert.match(result.stdout, /error\s+Unexpected console statement/);
    assert.doesNotMatch(result.stdout, /generated/);
    assert.equal(result.stderr.match(/useSortedClasses/g).length, 1);
  });
  await withProject(
    { ...files, "eslint.config.mjs": WRAP_ESLINT("{ biome: false }") },
    async (dir) => {
      await linkPackage(dir);
      const result = await arch(dir, "lint");
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.stderr, "");
    }
  );
});

test("a project Prettier config that wraps createConfig gets the Biome options and ignores", async () => {
  const biome = {
    formatter: { lineWidth: 100, indentStyle: "space" },
    files: { includes: ["**", "!**/generated"] },
  };
  const wide = `export const value = { alpha: 1, beta: 2, gamma: 3, delta: 4, epsilon: 5, zeta: 6 };\n`;
  const files = {
    "biome.json": json(biome),
    "prettier.config.mjs": WRAP_PRETTIER("{}"),
    "src/a.ts": wide,
    "src/generated/b.ts": "export const b   = 1\n",
  };
  await withProject(files, async (dir) => {
    await linkPackage(dir);
    const result = await arch(dir, "format", "src");
    assert.equal(result.code, 0, result.stdout + result.stderr);
  });
  await withProject(
    { ...files, "prettier.config.mjs": WRAP_PRETTIER("{ biome: false }") },
    async (dir) => {
      await linkPackage(dir);
      const result = await arch(dir, "format", "src");
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /src\/a\.ts/);
      assert.match(result.stdout + result.stderr, /src\/generated\/b\.ts/);
    }
  );
});

test("a package.json prettier key that names the bundled config gets the Biome ignores", async () => {
  await withProject(
    {
      "package.json": json({ name: "fx", prettier: "arch-lint/prettier" }),
      "biome.json": json({ files: { includes: ["**", "!**/generated"] } }),
      "src/generated/b.ts": "export const b   = 1\n",
    },
    async (dir) => {
      await linkPackage(dir);
      const result = await arch(dir, "format", "src");
      assert.equal(result.code, 0, result.stdout + result.stderr);
    }
  );
});

test("organize imports drops out of the Prettier plugins when Biome switches it off", async () => {
  await withProject(
    { "biome.json": json({ organizeImports: { enabled: false } }) },
    async (dir) => {
      assert.deepEqual(createPrettierConfig({ root: dir }).plugins, []);
    }
  );
  await withProject({ "biome.json": json({}) }, async (dir) => {
    assert.equal(createPrettierConfig({ root: dir }).plugins.length, 1);
  });
});
