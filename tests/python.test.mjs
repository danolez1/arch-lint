import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { detectPythonProjects } from "../src/commands/python.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/bin.mjs");

const RUFF_TOML = "line-length = 100\n";
const RUFF_PYPROJECT = "[tool.ruff]\nline-length = 100\n";
const BOTH_PYPROJECT = `${RUFF_PYPROJECT}\n[tool.mypy]\nstrict = true\n`;

const temps = [];
after(() =>
  Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })))
);

// Resolved so paths a fake tool prints with pwd -P match the paths the tests build.
async function tempDir() {
  const dir = await realpath(
    await mkdtemp(path.join(tmpdir(), "arch-lint-py-"))
  );
  temps.push(dir);
  return dir;
}

async function writeFiles(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
}

async function project(files = {}) {
  const dir = await tempDir();
  await writeFiles(dir, {
    "package.json": '{\n  "name": "fx",\n  "version": "1.0.0"\n}\n',
    ...files,
  });
  return dir;
}

// Only shell builtins, because PATH holds nothing but the fake tools.
const script = (log, exitCode) =>
  `#!/bin/sh\nprintf '%s|%s|%s\\n' "\${0##*/}" "$(pwd -P)" "$*" >> '${log}'\nexit ${exitCode}\n`;

async function writeExecutable(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  await chmod(file, 0o755);
}

async function fakeTools(exits) {
  const dir = await tempDir();
  const log = path.join(dir, "calls.log");
  for (const [name, code] of Object.entries(exits)) {
    await writeExecutable(path.join(dir, name), script(log, code));
  }
  return { dir, log };
}

async function calls(fake, base) {
  const text = await readFile(fake.log, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [tool, cwd, args] = line.split("|");
      return `${path.relative(base, cwd) || "."}: ${tool} ${args}`;
    });
}

async function arch(cwd, fake, args, extraPath = "") {
  const env = { ...process.env, PATH: fake.dir + extraPath };
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [cli, "--cwd", cwd, ...args],
      { env }
    );
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const twoServices = {
  "service-a/ruff.toml": RUFF_TOML,
  "service-b/pyproject.toml": BOTH_PYPROJECT,
};

test("detection finds ruff and mypy roots and skips ignored directories", async () => {
  const dir = await project({
    "service-a/ruff.toml": RUFF_TOML,
    "service-b/.ruff.toml": RUFF_TOML,
    "service-c/pyproject.toml": RUFF_PYPROJECT,
    "service-d/pyproject.toml": "[tool.mypy]\nstrict = true\n",
    "service-e/pyproject.toml": BOTH_PYPROJECT,
    "service-f/mypy.ini": "[mypy]\nstrict = True\n",
    "service-g/.mypy.ini": "[mypy-vendor.*]\nignore_errors = True\n",
    "service-h/setup.cfg": "[mypy]\nstrict = True\n",
    "service-i/setup.cfg": "[metadata]\nname = x\n",
    "service-j/pyproject.toml": '[project]\nname = "x"\n',
    "node_modules/pkg/ruff.toml": RUFF_TOML,
    "service-a/.venv/lib/ruff.toml": RUFF_TOML,
    "build/ruff.toml": RUFF_TOML,
    "dist/ruff.toml": RUFF_TOML,
  });
  const found = detectPythonProjects(dir).map(
    (p) =>
      `${path.relative(dir, p.dir)}:${p.ruff ? "ruff" : ""}${p.mypy ? "mypy" : ""}`
  );
  assert.deepEqual(found, [
    "service-a:ruff",
    "service-b:ruff",
    "service-c:ruff",
    "service-d:mypy",
    "service-e:ruffmypy",
    "service-f:mypy",
    "service-g:mypy",
    "service-h:mypy",
  ]);
});

test("a nested root is not run again by its parent's tool", async () => {
  const dir = await project({
    "service-a/ruff.toml": RUFF_TOML,
    "service-a/pkg/ruff.toml": RUFF_TOML,
    "service-a/pkg/mypy.ini": "[mypy]\n",
  });
  const found = detectPythonProjects(dir).map(
    (p) =>
      `${path.relative(dir, p.dir)}:${p.ruff ? "ruff" : ""}${p.mypy ? "mypy" : ""}`
  );
  assert.deepEqual(found, ["service-a:ruff", "service-a/pkg:mypy"]);
});

test("mypy roots are independent, so a nested mypy config still runs", async () => {
  const dir = await project({
    "service-a/pyproject.toml": BOTH_PYPROJECT,
    "service-a/pkg/mypy.ini": "[mypy]\nstrict = True\n",
    "service-a/pkg/ruff.toml": RUFF_TOML,
  });
  const found = detectPythonProjects(dir).map(
    (p) =>
      `${path.relative(dir, p.dir)}:${p.ruff ? "ruff" : ""}${p.mypy ? "mypy" : ""}`
  );
  assert.deepEqual(found, ["service-a:ruffmypy", "service-a/pkg:mypy"]);

  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const result = await arch(dir, fake, ["lint", "--python-only"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff check .",
    "service-a: mypy .",
    "service-a/pkg: mypy .",
  ]);
});

test("the project's .gitignore keeps ignored roots out", async (t) => {
  const git = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  if (!git) return t.skip("git is not installed");
  const dir = await project({
    ".gitignore": "ignored/\n",
    "ignored/ruff.toml": RUFF_TOML,
    "service-a/ruff.toml": RUFF_TOML,
  });
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const fake = await fakeTools({ ruff: 0 });
  const result = await arch(
    dir,
    fake,
    ["lint", "--python-only"],
    `${path.delimiter}${path.dirname(git)}`
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await calls(fake, dir), ["service-a: ruff check ."]);
});

test("lint runs ruff check, then mypy where configured, in each root", async () => {
  const dir = await project(twoServices);
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const result = await arch(dir, fake, ["lint", "--python-only"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff check .",
    "service-b: ruff check .",
    "service-b: mypy .",
  ]);
});

test("format and format:write map to ruff format", async () => {
  const dir = await project(twoServices);
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  assert.equal((await arch(dir, fake, ["format", "--python-only"])).code, 0);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff format --check .",
    "service-b: ruff format --check .",
  ]);
  await rm(fake.log, { force: true });
  assert.equal(
    (await arch(dir, fake, ["format:write", "--python-only"])).code,
    0
  );
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff format .",
    "service-b: ruff format .",
  ]);
});

test("fix runs ruff check --fix and then ruff format, without mypy", async () => {
  const dir = await project(twoServices);
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const result = await arch(dir, fake, ["fix", "--python-only"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff check --fix .",
    "service-b: ruff check --fix .",
    "service-a: ruff format .",
    "service-b: ruff format .",
  ]);
});

test("check covers lint and format for JavaScript and Python together", async () => {
  const dir = await project({
    ...twoServices,
    "src/a.ts": "export const a = 2;\n",
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const result = await arch(dir, fake, ["check", "--skip-arch"]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff check .",
    "service-b: ruff check .",
    "service-b: mypy .",
    "service-a: ruff format --check .",
    "service-b: ruff format --check .",
  ]);
});

test("check --python-only leaves JavaScript and the architecture rules out", async () => {
  const dir = await project({
    ...twoServices,
    "src/a.ts": "export const a: any = 1;\n",
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const result = await arch(dir, fake, ["check", "--python-only"]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.equal((await calls(fake, dir)).length, 5);
  assert.doesNotMatch(result.stdout, /== arch-lint arch/);
});

const SKIP_CONFIG = '{ "python": { "required": false } }\n';

test("a missing tool fails by default with one actionable line per root and tool", async () => {
  const dir = await project(twoServices);
  const fake = await fakeTools({});
  const result = await arch(dir, fake, ["lint", "--python-only"]);
  assert.equal(result.code, 1);
  const skip =
    'Install {t} or uv, or set "python": { "required": false } in arch-lint.config.json to skip.';
  assert.deepEqual(result.stderr.trim().split("\n"), [
    `arch-lint: python: ruff not found for service-a. ${skip.replace("{t}", "ruff")}`,
    `arch-lint: python: ruff not found for service-b. ${skip.replace("{t}", "ruff")}`,
    `arch-lint: python: mypy not found for service-b. ${skip.replace("{t}", "mypy")}`,
  ]);
  assert.doesNotMatch(result.stderr, /skipped/);
});

test("a Python root at the project root reads as the project root", async () => {
  const dir = await project({ "ruff.toml": RUFF_TOML });
  const result = await arch(dir, await fakeTools({}), [
    "format",
    "--python-only",
  ]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /ruff not found for the project root\./);
  assert.doesNotMatch(result.stderr, /for \.\./);
});

test('"python": { "required": false } skips a missing tool with a line and does not fail', async () => {
  const dir = await project({
    ...twoServices,
    "arch-lint.config.json": SKIP_CONFIG,
  });
  const fake = await fakeTools({});
  const result = await arch(dir, fake, ["lint", "--python-only"]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.stderr.trim().split("\n"), [
    "arch-lint: python: ruff not found for service-a, skipped. Install ruff or uv.",
    "arch-lint: python: ruff not found for service-b, skipped. Install ruff or uv.",
    "arch-lint: python: mypy not found for service-b, skipped. Install mypy or uv.",
  ]);
});

test('"python": { "required": true } behaves like the default', async () => {
  const dir = await project({
    ...twoServices,
    "arch-lint.config.json": '{ "python": { "required": true } }\n',
  });
  const result = await arch(dir, await fakeTools({}), [
    "format",
    "--python-only",
  ]);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /skipped/);
});

test("a missing tool still lets the other roots run before failing", async () => {
  const dir = await project(twoServices);
  const fake = await fakeTools({ mypy: 0 });
  await writeExecutable(
    path.join(dir, "service-a/.venv/bin/ruff"),
    script(fake.log, 0)
  );
  const result = await arch(dir, fake, ["lint", "--python-only"]);
  assert.equal(result.code, 1);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff check .",
    "service-b: mypy .",
  ]);
});

test("a malformed arch-lint.config.json is a usage error once a tool is missing", async () => {
  const dir = await project({
    ...twoServices,
    "arch-lint.config.json": "{ nope",
  });
  const result = await arch(dir, await fakeTools({}), [
    "lint",
    "--python-only",
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Cannot read .*arch-lint\.config\.json/);
});

test("--no-python runs nothing for Python and is not passed to ESLint", async () => {
  const dir = await project({
    ...twoServices,
    "src/a.ts": "export const a = 2;\n",
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const result = await arch(dir, fake, ["lint", "--no-python"]);
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.deepEqual(await calls(fake, dir), []);
});

test("the two Python flags cannot be combined", async () => {
  const dir = await project(twoServices);
  const result = await arch(dir, await fakeTools({ ruff: 0 }), [
    "lint",
    "--no-python",
    "--python-only",
  ]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /cannot be combined/);
});

test("fix honors the Python flags in both of its steps", async () => {
  const messy = "export function f( ){\n  var q = 1;\n  return q\n}\n";
  const dir = await project({ ...twoServices, "src/a.ts": messy });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });

  assert.equal((await arch(dir, fake, ["fix", "--python-only"])).code, 0);
  assert.equal(await readFile(path.join(dir, "src/a.ts"), "utf8"), messy);
  assert.equal((await calls(fake, dir)).length, 4);

  await rm(fake.log, { force: true });
  assert.equal((await arch(dir, fake, ["fix", "--no-python"])).code, 0);
  assert.equal(
    await readFile(path.join(dir, "src/a.ts"), "utf8"),
    "export function f() {\n  const q = 1;\n  return q;\n}\n"
  );
  assert.deepEqual(await calls(fake, dir), []);
});

test("a JavaScript-only project spawns no Python tool", async () => {
  const dir = await project({ "src/a.ts": "export const a = 2;\n" });
  const fake = await fakeTools({ ruff: 0, mypy: 0, uv: 0 });
  for (const args of [["lint"], ["format"], ["check", "--skip-arch"]]) {
    const result = await arch(dir, fake, args);
    assert.equal(result.code, 0, result.stderr + result.stdout);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(await calls(fake, dir), []);
});

test("a failing tool sets the exit code and the later steps still run", async () => {
  const dir = await project(twoServices);
  const fake = await fakeTools({ ruff: 3, mypy: 0 });
  const result = await arch(dir, fake, ["lint", "--python-only"]);
  assert.equal(result.code, 3);
  assert.equal((await calls(fake, dir)).length, 3);

  const onlyMypy = await fakeTools({ ruff: 0, mypy: 1 });
  assert.equal((await arch(dir, onlyMypy, ["lint", "--python-only"])).code, 1);
  assert.equal(
    (await arch(dir, onlyMypy, ["format", "--python-only"])).code,
    0
  );
});

test("check fails when a Python step fails and names the step", async () => {
  const dir = await project(twoServices);
  const fake = await fakeTools({ ruff: 1, mypy: 0 });
  const result = await arch(dir, fake, ["check", "--python-only"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /check failed: lint, format/);
});

test("mypy goes through uv run --directory in a uv project", async () => {
  const dir = await project({
    "service-a/pyproject.toml": BOTH_PYPROJECT,
    "service-a/uv.lock": "version = 1\n",
    "service-b/pyproject.toml": `${BOTH_PYPROJECT}\n[tool.uv]\ndev-dependencies = []\n`,
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0, uv: 0 });
  const result = await arch(dir, fake, ["lint", "--python-only"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff check .",
    `service-a: uv run --directory ${path.join(dir, "service-a")} mypy .`,
    "service-b: ruff check .",
    `service-b: uv run --directory ${path.join(dir, "service-b")} mypy .`,
  ]);
});

test("mypy comes from PATH when uv is absent or the project does not use uv", async () => {
  const dir = await project({ "service-a/pyproject.toml": BOTH_PYPROJECT });
  const withUv = await fakeTools({ ruff: 0, mypy: 0, uv: 0 });
  await arch(dir, withUv, ["lint", "--python-only"]);
  assert.deepEqual(await calls(withUv, dir), [
    "service-a: ruff check .",
    "service-a: mypy .",
  ]);

  await writeFiles(dir, { "service-a/uv.lock": "version = 1\n" });
  const withoutUv = await fakeTools({ ruff: 0, mypy: 0 });
  await arch(dir, withoutUv, ["lint", "--python-only"]);
  assert.deepEqual(await calls(withoutUv, dir), [
    "service-a: ruff check .",
    "service-a: mypy .",
  ]);
});

test("ruff falls back to uv tool run when it is not installed", async () => {
  const dir = await project({ "service-a/ruff.toml": RUFF_TOML });
  const fake = await fakeTools({ uv: 0 });
  const result = await arch(dir, fake, ["format", "--python-only"]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: uv tool run ruff format --check .",
  ]);
});

test("a .venv tool in the root beats the one on PATH", async () => {
  const dir = await project({ "service-a/ruff.toml": RUFF_TOML });
  const onPath = await fakeTools({ ruff: 0 });
  const venvLog = path.join(await tempDir(), "venv.log");
  await writeExecutable(
    path.join(dir, "service-a/.venv/bin/ruff"),
    script(venvLog, 0)
  );
  await arch(dir, onPath, ["lint", "--python-only"]);
  assert.deepEqual(await calls(onPath, dir), []);
  assert.deepEqual(await calls({ log: venvLog }, dir), [
    "service-a: ruff check .",
  ]);
});

test("a path inside a Python root limits ruff to that path", async () => {
  const dir = await project({
    ...twoServices,
    "service-a/pkg/mod.py": "x = 1\n",
    "service-a/app.py": "x = 1\n",
    "src/a.ts": "export const a = 2;\n",
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });

  await arch(dir, fake, [
    "lint",
    "--python-only",
    "service-a/pkg",
    "service-a/app.py",
  ]);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff check pkg app.py",
  ]);

  await rm(fake.log, { force: true });
  await arch(dir, fake, ["format:write", "--python-only", "."]);
  assert.deepEqual(await calls(fake, dir), [
    "service-a: ruff format .",
    "service-b: ruff format .",
  ]);

  await rm(fake.log, { force: true });
  const js = await arch(dir, fake, ["lint", "src"]);
  assert.equal(js.code, 0, js.stderr + js.stdout);
  assert.deepEqual(await calls(fake, dir), []);
});

const pathCases = {
  "svc/ruff.toml": RUFF_TOML,
  "svc/a.py": "x = 1\n",
  "svc/stubs/b.pyi": "x: int\n",
  "a.ts": "export const a = 2;\n",
};

test("a Python file path reaches ruff only, never ESLint or Prettier", async () => {
  const dir = await project(pathCases);
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const cases = [
    [["format", "svc/a.py"], ["svc: ruff format --check a.py"]],
    [["format:write", "svc/a.py"], ["svc: ruff format a.py"]],
    [["lint", "svc/a.py"], ["svc: ruff check a.py"]],
    [["lint", "svc/stubs/b.pyi"], ["svc: ruff check stubs/b.pyi"]],
    [
      ["fix", "svc/a.py"],
      ["svc: ruff check --fix a.py", "svc: ruff format a.py"],
    ],
  ];
  for (const [args, expected] of cases) {
    await rm(fake.log, { force: true });
    const result = await arch(dir, fake, args);
    const output = `${args.join(" ")}\n${result.stdout}${result.stderr}`;
    assert.equal(result.code, 0, output);
    assert.doesNotMatch(output, /No parser|File ignored|warning/);
    assert.deepEqual(await calls(fake, dir), expected, output);
  }
});

test("a JavaScript file path is never given to ruff, even at a Python root", async () => {
  const dir = await project({ "pyproject.toml": RUFF_PYPROJECT, ...pathCases });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  for (const args of [
    ["lint", "a.ts"],
    ["format", "a.ts"],
    ["format:write", "a.ts"],
    ["fix", "a.ts"],
  ]) {
    const result = await arch(dir, fake, args);
    assert.equal(result.code, 0, `${args}\n${result.stdout}${result.stderr}`);
  }
  assert.deepEqual(await calls(fake, dir), []);
});

test("a tool with no path left does not run and does not fall back to the whole project", async () => {
  const dir = await project({
    ...pathCases,
    "src/bad.ts": "var  q = 1\nexport {q}\n",
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  for (const args of [
    ["lint", "svc/a.py"],
    ["format", "svc/a.py"],
    ["format:write", "svc/a.py"],
    ["fix", "svc/a.py"],
  ]) {
    const result = await arch(dir, fake, args);
    assert.equal(result.code, 0, `${args}\n${result.stdout}${result.stderr}`);
  }
  assert.equal(
    await readFile(path.join(dir, "src/bad.ts"), "utf8"),
    "var  q = 1\nexport {q}\n"
  );

  await rm(fake.log, { force: true });
  const mixed = await arch(dir, fake, ["lint", "svc/a.py", "src"]);
  assert.equal(mixed.code, 1);
  assert.match(mixed.stdout, /src\/bad\.ts/);
  assert.deepEqual(await calls(fake, dir), ["svc: ruff check a.py"]);
});

test("a directory path goes to every tool", async () => {
  const dir = await project({
    ...pathCases,
    "svc/bad.ts": "var  q = 1;\nexport { q };\n",
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  const result = await arch(dir, fake, ["lint", "svc"]);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /svc\/bad\.ts/);
  assert.deepEqual(await calls(fake, dir), ["svc: ruff check ."]);

  await rm(fake.log, { force: true });
  const formatted = await arch(dir, fake, ["format", "svc"]);
  assert.equal(formatted.code, 1);
  assert.deepEqual(await calls(fake, dir), ["svc: ruff format --check ."]);
});

test("ESLint output flags keep Python out so the JSON stays parseable", async () => {
  const dir = await project({
    ...twoServices,
    "src/a.ts": "export const a = 2;\n",
  });
  const fake = await fakeTools({ ruff: 0, mypy: 0 });
  for (const flags of [
    ["-f", "json"],
    ["--format", "json"],
    ["--format=json"],
  ]) {
    const result = await arch(dir, fake, ["lint", ...flags]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].errorCount, 0);
    assert.equal(result.stderr.trim().split("\n").length, 1);
    assert.match(result.stderr, /^arch-lint: python: skipped/);
  }
  const out = path.join(dir, "report.json");
  for (const flags of [["-o", out], [`--output-file=${out}`]]) {
    const result = await arch(dir, fake, ["lint", ...flags]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /python: skipped/);
  }
  assert.deepEqual(await calls(fake, dir), []);
});

test("ESLint output flags say nothing about Python in a project without any", async () => {
  const dir = await project({ "src/a.ts": "export const a = 2;\n" });
  const result = await arch(dir, await fakeTools({ ruff: 0 }), [
    "lint",
    "-f",
    "json",
    "src",
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, "");
});

// Real uv and ruff, so it skips itself on a machine without them or without network access.
test("real ruff through uv formats and lints a project", async (t) => {
  const probe = spawnSync("uvx", ["ruff", "--version"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (probe.error || probe.status !== 0) {
    return t.skip("ruff is not reachable through uvx here");
  }
  const dir = await project({
    "service-a/ruff.toml": RUFF_TOML,
    "service-a/main.py": "x = {'a':1}\n",
  });
  const env = { ...process.env };
  const run = (...args) =>
    spawnSync(process.execPath, [cli, "--cwd", dir, ...args], { env });
  assert.equal(run("format", "--python-only").status, 1);
  assert.equal(run("format:write", "--python-only").status, 0);
  assert.equal(
    await readFile(path.join(dir, "service-a/main.py"), "utf8"),
    'x = {"a": 1}\n'
  );
  assert.equal(run("lint", "--python-only").status, 0);
});
