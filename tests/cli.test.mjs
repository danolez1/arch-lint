import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import "./no-color.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/bin.mjs");

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

const packageJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

// Written already formatted so format checks fail only because of the files a test adds.
async function project(
  files,
  pkg = packageJson({ name: "fx", version: "1.0.0" })
) {
  const dir = await mkdtemp(path.join(tmpdir(), "arch-lint-test-"));
  await writeFile(path.join(dir, "package.json"), pkg);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
  return dir;
}

async function withProject(files, fn, pkg) {
  const dir = await project(files, pkg);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("help and version", async () => {
  const help = await arch(root, "--help");
  assert.equal(help.code, 0);
  assert.match(help.stdout, /format:write/);
  const version = await arch(root, "--version");
  assert.equal(
    version.stdout.trim(),
    JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version
  );
});

test("unknown command exits 2", async () => {
  const result = await arch(root, "nope");
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command/);
});

test("--cwd accepts the equals form", async () => {
  await withProject({ "src/a.ts": "export const a = 2;\n" }, async (dir) => {
    const { code } = await execFileAsync(process.execPath, [
      cli,
      `--cwd=${dir}`,
      "lint",
    ]).then(
      () => ({ code: 0 }),
      (err) => ({ code: err.code })
    );
    assert.equal(code, 0);
  });
});

test("lint reports errors with the bundled config and passes clean code", async () => {
  await withProject(
    { "src/a.ts": "const unused = 1;\nexport const a = 2;\n" },
    async (bad) => {
      const failed = await arch(bad, "lint");
      assert.equal(failed.code, 1);
      assert.match(failed.stdout, /no-unused-vars/);
    }
  );
  await withProject({ "src/a.ts": "export const a = 2;\n" }, async (good) => {
    assert.equal((await arch(good, "lint")).code, 0);
  });
});

test("lint --fix repairs fixable problems", async () => {
  await withProject(
    { "src/a.ts": "export function f() {\n  var q = 1;\n  return q;\n}\n" },
    async (dir) => {
      assert.equal((await arch(dir, "lint")).code, 1);
      assert.equal((await arch(dir, "lint", "--fix")).code, 0);
      assert.match(
        await readFile(path.join(dir, "src/a.ts"), "utf8"),
        /const q = 1/
      );
    }
  );
});

test("format checks, writes, then passes", async () => {
  await withProject(
    { "src/a.ts": "export const a   =  {b:1}\n" },
    async (dir) => {
      const before = await arch(dir, "format", "src");
      assert.equal(before.code, 1);
      assert.match(before.stderr + before.stdout, /src\/a\.ts/);
      assert.equal((await arch(dir, "format:write")).code, 0);
      assert.equal(
        await readFile(path.join(dir, "src/a.ts"), "utf8"),
        "export const a = { b: 1 };\n"
      );
      assert.equal((await arch(dir, "format")).code, 0);
    }
  );
});

test("format passes Prettier options through instead of treating them as paths", async () => {
  await withProject({ "src/a.ts": "export const a   = 1;\n" }, async (dir) => {
    for (const flags of [
      ["--tab-width", "4"],
      ["--print-width", "100"],
      ["--trailing-comma", "none"],
    ]) {
      const result = await arch(dir, "format", ...flags);
      assert.equal(result.code, 1, flags.join(" "));
      assert.match(result.stderr + result.stdout, /src\/a\.ts/);
    }
  });
});

test("format -c is Prettier's --check, not a value flag", async () => {
  await withProject({ "src/a.ts": "export const a   = 1;\n" }, async (dir) => {
    const result = await arch(dir, "format", "-c", "src/a.ts");
    assert.equal(result.code, 1);
  });
});

test("fix hands only paths to Prettier, flags stay with ESLint", async () => {
  await withProject(
    { "src/a.ts": "export function f( ){\n  var q = 1;\n  return q\n}\n" },
    async (dir) => {
      const result = await arch(dir, "fix", "--quiet");
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.equal(
        await readFile(path.join(dir, "src/a.ts"), "utf8"),
        "export function f() {\n  const q = 1;\n  return q;\n}\n"
      );
    }
  );
});

test("a project prettier config wins over the bundled one", async () => {
  await withProject(
    {
      ".prettierrc.json": '{"singleQuote": true}\n',
      "src/a.ts": 'export const a = "x";\n',
    },
    async (dir) => {
      assert.equal((await arch(dir, "format", "src")).code, 1);
    }
  );
});

test("a parent directory config applies to a package inside it", async () => {
  await withProject(
    {
      ".prettierrc.json": '{"singleQuote": true}\n',
      "packages/app/src/a.ts": "export const a = 'x';\n",
      "packages/app/package.json": packageJson({ name: "app" }),
    },
    async (dir) => {
      const inner = path.join(dir, "packages/app");
      assert.equal((await arch(inner, "format", "src")).code, 0);
    }
  );
});

test("a project .prettierignore does not stop the bundled ignores", async () => {
  await withProject(
    {
      ".prettierignore": "node_modules\n",
      ".codeflow/out.json": '{"a":1,"b":[1,2]}',
      "src/a.ts": "export const a = 2;\n",
    },
    async (dir) => {
      assert.equal((await arch(dir, "format")).code, 0);
    }
  );
});

test("check runs lint and format and fails when either does", async () => {
  await withProject({ "src/a.ts": "export const a = 2;\n" }, async (dir) => {
    const result = await arch(dir, "check", "--skip-arch");
    assert.equal(result.code, 0, result.stderr + result.stdout);
  });
  await withProject({ "src/a.ts": "const unused = 1;\n" }, async (dir) => {
    const result = await arch(dir, "check", "--skip-arch");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /check failed: lint/);
  });
});

test("check passes on a project with no JavaScript or TypeScript", async () => {
  await withProject({ "docs/readme.md": "# Title\n" }, async (dir) => {
    const result = await arch(dir, "check", "--skip-arch");
    assert.equal(result.code, 0, result.stderr + result.stdout);
  });
});

test("init adds scripts, keeps existing ones and writes a config", async () => {
  await withProject(
    {},
    async (dir) => {
      assert.equal((await arch(dir, "init")).code, 0);
      const pkg = JSON.parse(
        await readFile(path.join(dir, "package.json"), "utf8")
      );
      assert.equal(pkg.scripts.lint, "keep-me");
      assert.equal(pkg.scripts["format:write"], "arch-lint format:write");
      assert.equal(pkg.scripts.check, "arch-lint check");
      const config = JSON.parse(
        await readFile(path.join(dir, "arch-lint.config.json"), "utf8")
      );
      assert.deepEqual(config.extends, ["preset:recommended"]);
    },
    packageJson({ name: "fx", scripts: { lint: "keep-me" } })
  );
});

test("arch lists the registered rules", async () => {
  await withProject({}, async (dir) => {
    const result = await arch(dir, "arch", "--list");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^no-raw-throw\s/m);
    assert.match(result.stdout, /^migration-journal-order\s/m);
  });
});

test("arch --help lists the supported command options", async () => {
  await withProject({}, async (dir) => {
    const result = await arch(dir, "arch", "--help");
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.match(result.stdout, /Usage: arch-lint arch \[options\]/);
    assert.match(result.stdout, /--format <format>/);
    assert.match(result.stdout, /--watch/);
  });
});

test("arch reports a violation from the project's config and exits 1", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        rules: { "no-any": "error" },
      }),
      "src/a.ts": "export const a: any = 1;\n",
    },
    async (dir) => {
      const result = await arch(dir, "arch", "--rule", "no-any");
      assert.equal(result.code, 1, result.stderr + result.stdout);
      assert.match(result.stdout, /no-any/);
      assert.match(result.stdout, /src\/a\.ts:1/);
    }
  );
});

test("arch passes a clean project and honors exemptions", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        rules: { "no-any": { exempt: { files: ["src/legacy.ts"] } } },
      }),
      "src/a.ts": "export const a: number = 1;\n",
      "src/legacy.ts": "export const b: any = 1;\n",
    },
    async (dir) => {
      const result = await arch(dir, "arch", "--rule", "no-any");
      assert.equal(result.code, 0, result.stderr + result.stdout);
      assert.match(result.stdout, /Architecture lint passed/);
    }
  );
});

test("arch baseline records debt and then only fails on new violations", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        rules: { "no-any": "error" },
      }),
      "src/a.ts": "export const a: any = 1;\n",
    },
    async (dir) => {
      assert.equal(
        (await arch(dir, "arch", "--rule", "no-any", "--update-baseline")).code,
        0
      );
      assert.equal((await arch(dir, "arch", "--rule", "no-any")).code, 0);
      await writeFile(path.join(dir, "src/b.ts"), "export const b: any = 2;\n");
      assert.equal((await arch(dir, "arch", "--rule", "no-any")).code, 1);
    }
  );
});

test("worsening baseline reports higher graph metrics as a new finding", async () => {
  await withProject(
    {
      "arch-lint.config.json": packageJson({
        scan: ["src"],
        defaultLevel: "off",
        baselineMode: "worsening",
        rules: {
          "high-coupling": {
            level: "error",
            options: { maxFanIn: 1, maxFanOut: 10 },
          },
        },
      }),
      "src/one.ts": 'import "./hub";\n',
      "src/two.ts": 'import "./hub";\n',
      "src/hub.ts": "export {};\n",
    },
    async (dir) => {
      assert.equal((await arch(dir, "arch", "--update-baseline")).code, 0);
      const baseline = JSON.parse(
        await readFile(path.join(dir, "arch-lint.baseline.json"), "utf8")
      );
      assert.equal(baseline.version, 5);
      assert.equal(baseline.mode, "worsening");
      assert.equal((await arch(dir, "arch")).code, 0);
      await writeFile(path.join(dir, "src/three.ts"), 'import "./hub";\n');
      const changed = await arch(dir, "arch");
      assert.equal(changed.code, 1, changed.stderr + changed.stdout);
      assert.match(changed.stdout, /fan-in 3/);
    }
  );
});

test("arch rejects unknown options and missing values", async () => {
  await withProject({}, async (dir) => {
    assert.notEqual((await arch(dir, "arch", "--nope")).code, 0);
    assert.notEqual((await arch(dir, "arch", "--rule")).code, 0);
  });
});

test("codeflow analyze runs the bundled headless analyzer", async () => {
  const fixture = path.join(root, "tests/codeflow/fixtures/golden-world");
  await withProject({}, async (dir) => {
    const out = path.join(dir, "out");
    const result = await arch(
      dir,
      "codeflow",
      "analyze",
      "--path",
      fixture,
      "--out",
      out,
      "--no-tracked"
    );
    assert.equal(result.code, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.files, 6);
    const envelope = JSON.parse(
      await readFile(path.join(out, "golden-world.json"), "utf8")
    );
    assert.equal(envelope.schemaVersion, 1);
  });
});

test("codeflow rejects unknown options and stray arguments", async () => {
  assert.equal((await arch(root, "codeflow", "analyze", "--bogus")).code, 2);
  assert.equal((await arch(root, "codeflow", "analyze", "stray")).code, 2);
  assert.equal((await arch(root, "codeflow", "serve")).code, 2);
});

test("arch without --rule runs every enabled rule", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        rules: { "no-any": "error", "no-empty-catch": "error" },
      }),
      "src/a.ts": "export const a: any = 1;\n",
      "src/b.ts": "try { run(); } catch {}\n",
    },
    async (dir) => {
      const result = await arch(dir, "arch");
      assert.equal(result.code, 1, result.stderr + result.stdout);
      assert.match(result.stdout, /no-any/);
      assert.match(result.stdout, /no-empty-catch/);
    }
  );
});

test("arch --graph preserves an explicit graph rule selection", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        layers: { x: ["src/x/"], y: ["src/y/"] },
        allowedDependencies: { x: [], y: ["x"] },
      }),
      "src/x/a.ts": 'import "../y/b";\n',
      "src/y/b.ts": 'import "../x/a";\n',
    },
    async (dir) => {
      const result = await arch(
        dir,
        "arch",
        "--graph",
        "--rule",
        "circular-dependency",
        "--format",
        "json"
      );
      assert.equal(result.code, 1, result.stderr + result.stdout);
      const report = JSON.parse(result.stdout);
      assert.deepEqual(
        [...new Set(report.findings.map(({ rule }) => rule))],
        ["circular-dependency"]
      );
    }
  );
});

test("arch --format metrics reports file and layer coupling without gating", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        layers: { app: ["src/app/"], domain: ["src/domain/"] },
      }),
      "src/app/page.ts": 'import "../domain/model";\n',
      "src/domain/model.ts": "export {};\n",
    },
    async (dir) => {
      const result = await arch(dir, "arch", "--format", "metrics");
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.files[0].fanOut, 1);
      assert.equal(report.layers[0].layer, "app");
      assert.equal(report.layers[1].Ca, 1);
      assert.equal(report.layers[1].I, 0);
    }
  );
});

test("arch --format metrics includes layers declared in ADR files", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        adrDir: "docs/adr",
        defaultLevel: "off",
      }),
      "docs/adr/001-layers.md": [
        "```archlint",
        "layer app = src/app/",
        "layer db = src/db/",
        "```",
      ].join("\n"),
      "src/app/page.ts": 'import "../db/query";\n',
      "src/db/query.ts": "export {};\n",
    },
    async (dir) => {
      const result = await arch(dir, "arch", "--format", "metrics");
      assert.equal(result.code, 0, result.stderr + result.stdout);
      const metrics = JSON.parse(result.stdout);
      assert.deepEqual(
        metrics.layers.map(({ layer }) => layer),
        ["app", "db"]
      );
      assert.equal(metrics.layers[0].Ce, 1);
      assert.equal(metrics.layers[1].Ca, 1);
    }
  );
});

test("arch --watch reloads rule configuration after it changes", async () => {
  const dir = await project({
    "arch-lint.config.json": JSON.stringify({
      scan: ["src"],
      defaultLevel: "off",
      adrDir: "docs/adr",
      rules: { "test-file-leakage": "error" },
      extends: ["./shared/base.json"],
    }),
    "shared/base.json": JSON.stringify({
      rules: { "no-any": "error", "no-console": "off" },
    }),
    "src/a.ts": 'console.log("value");\nexport const a: any = 1;\n',
    "src/app.ts": 'import { helper } from "../tests/helper.test";\nhelper();\n',
    "src/service/a.ts": 'import "../db/query";\n',
    "src/db/query.ts": "export {};\n",
    "docs/adr/001-boundaries.md": "# Boundaries\n```archlint\n```\n",
    "tests/placeholder.md": "test fixtures\n",
  });
  const child = spawn(
    process.execPath,
    [cli, "--cwd", dir, "arch", "--watch"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const childExit = new Promise((resolve) => child.once("exit", resolve));
  const outputClosed = new Promise((resolve) =>
    child.stdout.once("end", resolve)
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    output += chunk;
  });
  const waitForText = async (text, occurrence = 1) => {
    const deadline = Date.now() + 10_000;
    while (output.split(text).length - 1 < occurrence) {
      if (child.exitCode !== null)
        throw new Error(`watch process exited before ${text}:\n${output}`);
      if (Date.now() >= deadline)
        throw new Error(`watch output did not include ${text}:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  try {
    await waitForText("no-any");
    await writeFile(
      path.join(dir, "shared/base.json"),
      JSON.stringify({
        rules: { "no-any": "off", "no-console": "error" },
      })
    );
    await waitForText("Architecture inputs changed.");
    await writeFile(
      path.join(dir, "shared/base.json"),
      JSON.stringify({
        rules: { "no-any": "error", "no-console": "off" },
      })
    );
    await waitForText("no-console");
    await waitForText("Architecture inputs changed.", 2);
    await waitForText("no-any", 2);
    await writeFile(
      path.join(dir, "docs/adr/001-boundaries.md"),
      [
        "# Boundaries",
        "```archlint",
        "layer service = src/service/",
        "layer db = src/db/",
        "deny service -> db",
        "```",
      ].join("\n")
    );
    await waitForText("denied by docs/adr/001-boundaries.md");
    await writeFile(
      path.join(dir, "tests/helper.test.ts"),
      "export function helper() {}\n"
    );
    await waitForText("src/app.ts imports test-only file tests/helper.test.ts");
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGINT");
      await Promise.all([childExit, outputClosed]);
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("init then check passes on a clean project", async () => {
  await withProject({ "src/a.ts": "export const a = 2;\n" }, async (dir) => {
    assert.equal((await arch(dir, "init")).code, 0);
    const result = await arch(dir, "check");
    assert.equal(result.code, 0, result.stderr + result.stdout);
  });
});

test("init keeps a four space package.json indentation", async () => {
  await withProject({}, async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      '{\n    "name": "fx",\n    "version": "1.0.0"\n}\n'
    );
    assert.equal((await arch(dir, "init")).code, 0);
    const text = await readFile(path.join(dir, "package.json"), "utf8");
    assert.match(text, /^ {4}"name"/m);
  });
});

test("check runs the architecture rules even without a config file", async () => {
  await withProject(
    { "src/a.ts": "export const a: any = 1;\n" },
    async (dir) => {
      const result = await arch(dir, "check");
      assert.equal(result.code, 1);
      assert.match(result.stderr, /check failed:.*arch/);
    }
  );
});

test("arch reports the older rule id a config uses and baselines match either id", async () => {
  await withProject(
    {
      "arch-lint.config.json": JSON.stringify({
        scan: ["src"],
        defaultLevel: "off",
        rules: { "no-console-log": "error" },
      }),
      "src/a.ts": "console.log(1);\n",
    },
    async (dir) => {
      const first = await arch(dir, "arch");
      assert.equal(first.code, 1);
      assert.match(first.stdout, /^no-console-log \(1\)/m);
      assert.equal((await arch(dir, "arch", "--update-baseline")).code, 0);
      const baseline = JSON.parse(
        await readFile(path.join(dir, "arch-lint.baseline.json"), "utf8")
      );
      assert.equal(baseline.version, 5);
      assert.equal(baseline.mode, "identity");
      assert.equal(baseline.findings.length, 1);
      assert.deepEqual(baseline.legacy, {});
      await writeFile(
        path.join(dir, "arch-lint.config.json"),
        JSON.stringify({
          scan: ["src"],
          defaultLevel: "off",
          rules: { "no-console": "error" },
        })
      );
      assert.equal((await arch(dir, "arch")).code, 0);
    }
  );
});
