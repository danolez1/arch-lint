import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "src/bin.mjs");

const scratch = await mkdtemp(path.join(tmpdir(), "arch-lint-hooks-"));
after(() => rm(scratch, { recursive: true, force: true }));

// An empty global config and no inherited GIT_* variables keep the machine's own hooks and settings out of the temp repos.
const emptyGitConfig = path.join(scratch, "gitconfig");
await writeFile(emptyGitConfig, "");
const env = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))
  ),
  GIT_CONFIG_GLOBAL: emptyGitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

async function spawnIn(cmd, args, cwd, extraEnv = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      env: { ...env, ...extraEnv },
      maxBuffer: 1 << 28,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

const arch = (cwd, ...args) =>
  spawnIn(process.execPath, [cli, "--cwd", cwd, ...args], cwd);
const archWithEnv = (cwd, extraEnv, ...args) =>
  spawnIn(process.execPath, [cli, "--cwd", cwd, ...args], cwd, extraEnv);
const git = (cwd, ...args) => spawnIn("git", args, cwd);

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text);
  }
}

async function withDir(files, fn) {
  const dir = await mkdtemp(path.join(scratch, "dir-"));
  try {
    await write(dir, files);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function withRepo(files, fn) {
  return withDir(
    { "package.json": json({ name: "fx", version: "1.0.0" }), ...files },
    async (dir) => {
      await git(dir, "init", "-q");
      await git(dir, "config", "user.name", "Test User");
      await git(dir, "config", "user.email", "test@example.com");
      await git(dir, "config", "commit.gpgsign", "false");
      return fn(dir);
    }
  );
}

// npx --no-install finds the CLI through node_modules/.bin, so the hooks can run it from a temp repo.
async function linkCli(dir) {
  const bin = path.join(dir, "node_modules/.bin/arch-lint");
  await write(dir, {
    "node_modules/.bin/arch-lint": `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`,
    ".gitignore": "node_modules/\n",
  });
  await chmod(bin, 0o755);
  // The project-wide checks in the hooks read every file, including configs the test wrote unformatted.
  assert.equal((await arch(dir, "format:write")).code, 0);
}

// A config without extends turns every rule on, which a throwaway project would fail.
const config = (extra) => json({ extends: ["preset:recommended"], ...extra });

const clean = "export const a = 2;\n";
const lintError = "const unused = 1;\nexport const a = 2;\n";

async function message(text, config) {
  return withDir(
    {
      MSG: text,
      ...(config ? { "arch-lint.config.json": json({ commit: config }) } : {}),
    },
    (dir) => arch(dir, "commit-msg", "MSG")
  );
}

test("commit-msg accepts conventional headers", async () => {
  for (const text of [
    "feat: add the thing\n",
    "fix(api): handle empty input\n",
    "refactor(core)!: drop the old entry point\n",
    "chore(deps,ci): bump versions\n\nBody text.\n",
    "revert: undo the thing\n",
  ]) {
    const result = await message(text);
    assert.equal(result.code, 0, `${text}: ${result.stderr}`);
    assert.equal(result.stderr, "");
  }
});

test("commit-msg rejects a type that is not allowed and honors custom types", async () => {
  const bad = await message("wip: half done\n");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /commit-msg: type "wip" is not allowed/);
  assert.match(bad.stderr, /feat, fix, docs/);

  assert.equal((await message("wip: half done\n", { types: ["wip"] })).code, 0);
  assert.equal((await message("feat: x\n", { types: ["wip"] })).code, 1);
});

test("commit-msg rejects an upper case type with one line", async () => {
  const result = await message("Feat: add the thing\n");
  assert.equal(result.code, 1);
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.match(result.stderr, /type "Feat" must be lower case/);
});

test("commit-msg rejects a header that is not type(scope): subject", async () => {
  for (const text of ["Added a thing\n", "feat add\n", "feat (api): x\n"]) {
    const result = await message(text);
    assert.equal(result.code, 1, text);
    assert.match(result.stderr, /header must look like type\(scope\): subject/);
  }
  const spaced = await message("feat:add\n");
  assert.equal(spaced.code, 1);
  assert.match(spaced.stderr, /space is needed after the colon/);
});

test("commit-msg rejects a missing subject", async () => {
  for (const text of ["feat:\n", "feat: \n", "fix(api):   \n"]) {
    const result = await message(text);
    assert.equal(result.code, 1, text);
    assert.match(result.stderr, /subject must not be empty/);
  }
});

test("commit-msg rejects a trailing period", async () => {
  const result = await message("fix: tidy up.\n");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /subject must not end with a period/);
});

test("commit-msg enforces the header length limit", async () => {
  const long = `feat: ${"a".repeat(95)}\n`;
  const result = await message(long);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /header is 101 characters, the limit is 100/);
  assert.equal((await message(long, { maxHeaderLength: 120 })).code, 0);
  assert.equal(
    (await message("feat: abcdefgh\n", { maxHeaderLength: 10 })).code,
    1
  );
});

test("commit-msg treats an unknown scope as a warning by default", async () => {
  const result = await message("feat(web): x\n", { scopes: ["api", "db"] });
  assert.equal(result.code, 0);
  assert.match(
    result.stderr,
    /commit-msg: warning: scope "web" is not one of: api, db/
  );
  const known = await message("feat(api): x\n", { scopes: ["api", "db"] });
  assert.equal(known.stderr, "");
});

test("commit-msg fails an unknown scope when scopeLevel is error", async () => {
  const result = await message("feat(web): x\n", {
    scopes: ["api"],
    scopeLevel: "error",
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /commit-msg: scope "web" is not one of: api/);
  assert.doesNotMatch(result.stderr, /warning/);
  assert.equal(
    (await message("feat(api): x\n", { scopes: ["api"], scopeLevel: "error" }))
      .code,
    0
  );
});

test("commit-msg requires a scope only when requireScope is set", async () => {
  assert.equal((await message("feat: x\n")).code, 0);
  const result = await message("feat: x\n", { requireScope: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /scope is required/);
  assert.equal((await message("feat(a): x\n", { requireScope: true })).code, 0);
  const empty = await message("feat(): x\n");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /scope must not be empty/);
});

test("commit-msg skips merge, revert, fixup and squash commits", async () => {
  for (const text of [
    "Merge branch 'topic' into main\n",
    "Merge pull request #4 from someone/topic\n",
    'Revert "feat: add the thing"\n\nThis reverts commit abc123.\n',
    "fixup! feat: add the thing\n",
    "squash! feat: add the thing\n",
  ]) {
    const result = await message(text);
    assert.equal(result.code, 0, `${text}: ${result.stderr}`);
  }
});

test("commit-msg bans configured trailers case-insensitively, on skipped commits too", async () => {
  const config = { forbidTrailers: ["^co-authored-by:", "generated with"] };
  const body = "feat: add\n\nCO-AUTHORED-BY: Someone <a@example.com>\n";
  const result = await message(body, config);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /line 3 matches the forbidden pattern/);
  assert.equal((await message(body)).code, 0);

  const tool = await message("feat: add\n\nGenerated with a tool\n", config);
  assert.equal(tool.code, 1);

  const merge = await message(
    "Merge branch 'x'\n\nCo-Authored-By: A <a@b.c>\n",
    config
  );
  assert.equal(merge.code, 1);
});

test("commit-msg ignores comment lines", async () => {
  const result = await message(
    "# Please enter the commit message\nfeat: add\n# Changes to be committed:\n#\tnew file: a\n"
  );
  assert.equal(result.code, 0, result.stderr);
  const fake = await message("# feat: add\nnot a header\n");
  assert.equal(fake.code, 1);
  const trailer = await message("feat: add\n# co-authored-by: x\n", {
    forbidTrailers: ["co-authored-by"],
  });
  assert.equal(trailer.code, 0);
  const bare = await message("feat: add\n#\n");
  assert.equal(bare.code, 0, bare.stderr);
});

test("commit-msg treats a hash glued to text as content, not a comment", async () => {
  const header = await message("#123 feat: x\n");
  assert.equal(header.code, 1);
  assert.match(header.stderr, /header must look like type\(scope\): subject/);
  assert.doesNotMatch(header.stderr, /empty/);

  const body = await message("feat: x\n\n#42 banned-word here\n", {
    forbidTrailers: ["banned-word"],
  });
  assert.equal(body.code, 1);
  assert.match(body.stderr, /line 3 matches the forbidden pattern/);

  // Only a space or tab after the hash makes a comment, other characters do not.
  const shebang = await message("#!feat: x\n");
  assert.equal(shebang.code, 1);
  assert.doesNotMatch(shebang.stderr, /empty/);
  const semicolon = await message("; feat: x\n");
  assert.equal(semicolon.code, 1);
  assert.match(semicolon.stderr, /header must look like/);
});

test("commit-msg ignores everything from the scissors line on", async () => {
  const scissors = "# ------------------------ >8 ------------------------";
  const diff = [
    scissors,
    "# Do not modify or remove the line above.",
    "diff --git a/x b/x",
    "+Generated with a tool",
    "+not a header either",
    "",
  ].join("\n");
  const verbose = await message(`feat: add\n\n${diff}`, {
    forbidTrailers: ["generated with"],
  });
  assert.equal(verbose.code, 0, verbose.stderr);

  // A message that is only the scissors block is empty.
  const empty = await message(`\n${diff}`);
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /commit message is empty/);

  // Lines before the scissors still count, with their original line numbers.
  const before = await message(`feat: add\n\nGenerated with a tool\n${diff}`, {
    forbidTrailers: ["generated with"],
  });
  assert.equal(before.code, 1);
  assert.match(before.stderr, /line 3 matches/);
  assert.doesNotMatch(before.stderr, /line [4-9]/);

  // CRLF endings, as some editors write them.
  const crlf = await message(
    `feat: add\r\n\r\n${diff.replace(/\n/g, "\r\n")}`,
    {
      forbidTrailers: ["generated with"],
    }
  );
  assert.equal(crlf.code, 0, crlf.stderr);
});

test("commit-msg reports an empty message, a missing file and a broken config", async () => {
  const empty = await message("# only a comment\n\n");
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /commit message is empty/);

  await withDir({}, async (dir) => {
    assert.equal((await arch(dir, "commit-msg")).code, 2);
    assert.equal((await arch(dir, "commit-msg", "nope")).code, 2);
  });
  await withDir(
    { MSG: "feat: x\n", "arch-lint.config.json": "{ nope" },
    async (dir) => assert.equal((await arch(dir, "commit-msg", "MSG")).code, 2)
  );
  const level = await message("feat: x\n", { scopeLevel: "loud" });
  assert.equal(level.code, 2);
  assert.match(level.stderr, /commit\.scopeLevel/);
  const pattern = await message("feat: x\n", { forbidTrailers: ["("] });
  assert.equal(pattern.code, 2);
});

test("staged with nothing staged exits 0 with one line", async () => {
  await withRepo({ "src/a.ts": lintError }, async (dir) => {
    const result = await arch(dir, "staged");
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.match(result.stdout, /no staged files/);
  });
});

test("staged passes a clean staged file and ignores unstaged ones", async () => {
  await withRepo(
    { "src/a.ts": clean, "src/unstaged.ts": lintError },
    async (dir) => {
      await git(dir, "add", "src/a.ts");
      const result = await arch(dir, "staged");
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /staged lint \(1 file\)/);
      assert.match(result.stdout, /staged arch/);
      assert.match(result.stdout, /arch-lint staged passed/);
      assert.doesNotMatch(result.stdout, /unstaged\.ts/);
    }
  );
});

test("staged fails a file that ESLint rejects and says which step failed", async () => {
  await withRepo({ "src/a.ts": lintError }, async (dir) => {
    await git(dir, "add", "src/a.ts");
    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /no-unused-vars/);
    assert.match(result.stderr, /staged failed: lint$/m);
  });
});

test("staged fails a Prettier violation without rewriting the file", async () => {
  const bad = "export const a   = 1;\n";
  await withRepo({ "src/a.ts": bad }, async (dir) => {
    await git(dir, "add", "src/a.ts");
    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 1);
    assert.match(result.stdout + result.stderr, /src\/a\.ts/);
    assert.match(result.stderr, /staged failed: format$/m);
    assert.equal(await readFile(path.join(dir, "src/a.ts"), "utf8"), bad);
  });
});

test("staged keeps going after a failure so every step reports", async () => {
  await withRepo(
    {
      "src/a.ts": lintError,
      "src/b.ts": "export const b   = 1;\n",
      "arch-lint.config.json": json({
        scan: ["src"],
        defaultLevel: "off",
        rules: { "no-any": "error" },
      }),
      "src/c.ts": "export const c: any = 1;\n",
    },
    async (dir) => {
      await git(dir, "add", "src/a.ts", "src/b.ts");
      const result = await arch(dir, "staged");
      assert.equal(result.code, 1);
      assert.match(result.stderr, /staged failed: lint, format, arch$/m);
    }
  );
});

test("staged --no-arch leaves the architecture rules out", async () => {
  await withRepo({ "src/a.ts": clean }, async (dir) => {
    await git(dir, "add", "src/a.ts");
    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /staged arch/);
  });
});

test("staged --fix rewrites the working tree, prints what changed and stages nothing", async () => {
  const bad = "export function f( ){\n  var q = 1;\n  return q\n}\n";
  await withRepo({ "src/a.ts": bad }, async (dir) => {
    await git(dir, "add", "src/a.ts");
    const result = await arch(dir, "staged", "--fix", "--no-arch");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /not re-staged.*src\/a\.ts/);
    assert.equal(
      await readFile(path.join(dir, "src/a.ts"), "utf8"),
      "export function f() {\n  const q = 1;\n  return q;\n}\n"
    );
    assert.equal((await git(dir, "show", ":src/a.ts")).stdout, bad);
    assert.equal(
      (await git(dir, "diff", "--name-only")).stdout.trim(),
      "src/a.ts"
    );
  });
});

test("staged without --fix never rewrites files", async () => {
  const bad = "export function f( ){\n  var q = 1;\n  return q\n}\n";
  await withRepo({ "src/a.ts": bad }, async (dir) => {
    await git(dir, "add", "src/a.ts");
    assert.equal((await arch(dir, "staged", "--no-arch")).code, 1);
    assert.equal(await readFile(path.join(dir, "src/a.ts"), "utf8"), bad);
  });
});

// A stand-in ruff that records its arguments, so a test can see exactly which files it was given.
async function fakeRuff() {
  const bin = await mkdtemp(path.join(scratch, "bin-"));
  const log = path.join(bin, "ruff.log");
  await write(bin, { ruff: `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n` });
  await chmod(path.join(bin, "ruff"), 0o755);
  return {
    env: { PATH: `${bin}${path.delimiter}${env.PATH}` },
    calls: async () => {
      try {
        return (await readFile(log, "utf8")).split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}

test("staged routes files by type like lint and format do", async () => {
  const ruff = await fakeRuff();
  await withRepo(
    {
      "pyproject.toml": "[tool.ruff]\nline-length = 88\n",
      "app/main.py": "x = 1\n",
      "src/b.ts": "export const b = 2;\n",
      "notes.txt": "anything   goes   here\n",
      "docs/readme.md": "# Title\n",
    },
    async (dir) => {
      await git(dir, "add", "-A");
      const result = await archWithEnv(dir, ruff.env, "staged", "--no-arch");
      assert.equal(result.code, 0, result.stdout + result.stderr);

      const calls = await ruff.calls();
      assert.ok(calls.length >= 2, `ruff calls: ${calls}`);
      assert.ok(
        calls.some((call) => /^check .*app\/main\.py/.test(call)),
        `ruff lint call: ${calls}`
      );
      assert.ok(
        calls.some((call) => /^format --check .*app\/main\.py/.test(call)),
        `ruff format call: ${calls}`
      );
      assert.ok(
        calls.every((call) => !/\.(?:ts|md|txt|json)\b/.test(call)),
        `ruff must only get Python: ${calls}`
      );

      // Prettier exits 2 with "No parser could be inferred" on a .py file, ESLint warns about it.
      const output = result.stdout + result.stderr;
      assert.doesNotMatch(output, /No parser could be inferred/);
      assert.doesNotMatch(output, /main\.py/);
      // Prettier checks package.json, the markdown, b.ts and, through ruff, main.py; lint covers b.ts and main.py.
      assert.match(result.stdout, /staged lint \(2 files\)/);
      assert.match(result.stdout, /staged format \(4 files\)/);
    }
  );
});

test("staged leaves Python out when no ruff project exists", async () => {
  const ruff = await fakeRuff();
  await withRepo(
    { "broken.py": "def (:\n", "src/b.ts": clean },
    async (dir) => {
      await git(dir, "add", "-A");
      const result = await archWithEnv(dir, ruff.env, "staged", "--no-arch");
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.deepEqual(await ruff.calls(), []);
    }
  );
});

test("staged rejects unknown arguments", async () => {
  await withRepo({}, async (dir) => {
    assert.equal((await arch(dir, "staged", "--nope")).code, 2);
    assert.equal((await arch(dir, "staged", "src/a.ts")).code, 2);
  });
  await withDir({}, async (dir) => {
    assert.equal((await arch(dir, "staged")).code, 2);
  });
});

test("staged fails when a staged file also has unstaged changes, and names the files", async () => {
  await withRepo({ "src/a.ts": clean, "src/b.ts": clean }, async (dir) => {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "feat: first");
    // The index gets the lint error, the working tree is clean again.
    await write(dir, { "src/a.ts": lintError, "src/b.ts": lintError });
    await git(dir, "add", "src/a.ts", "src/b.ts");
    await write(dir, { "src/a.ts": clean });
    await write(dir, { "src/c.ts": lintError });

    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /not staged.*: src\/a\.ts$/m);
    assert.doesNotMatch(result.stderr, /src\/b\.ts|src\/c\.ts/);
    assert.match(result.stderr, /git add/);
    assert.match(result.stderr, /git stash --keep-index/);
    assert.equal(result.stderr.trim().split("\n").length, 2);
    assert.doesNotMatch(result.stdout, /== arch-lint staged/);
  });
});

test("staged --allow-partial checks the working tree copy and warns with the same list", async () => {
  await withRepo({ "src/a.ts": clean }, async (dir) => {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "feat: first");
    await write(dir, { "src/a.ts": lintError });
    await git(dir, "add", "src/a.ts");
    await write(dir, { "src/a.ts": clean });

    const result = await arch(dir, "staged", "--allow-partial", "--no-arch");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /warning: .*: src\/a\.ts$/m);
    assert.match(result.stdout, /arch-lint staged passed/);
  });
});

test("staged with only fully staged files is not treated as partial", async () => {
  await withRepo({ "src/a.ts": clean, "src/other.ts": clean }, async (dir) => {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "feat: first");
    await write(dir, { "src/a.ts": "export const a = 3;\n" });
    await git(dir, "add", "src/a.ts");
    await write(dir, { "src/other.ts": lintError });
    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stderr, /not staged|warning/);
  });
});

test("staged skips a staged file that is gone from the working tree with one stderr note", async () => {
  await withRepo({ "src/a.ts": clean, "src/b.ts": clean }, async (dir) => {
    await git(dir, "add", "-A");
    await rm(path.join(dir, "src/a.ts"));

    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    const notes = result.stderr.split("\n").filter(Boolean);
    assert.equal(notes.length, 1, result.stderr);
    assert.match(notes[0], /skipped.*: src\/a\.ts$/);
    assert.doesNotMatch(result.stdout + result.stderr, /No files matching/);
    assert.match(result.stdout, /staged lint \(1 file\)/);
  });
  // With every staged file gone there is nothing for ESLint and Prettier, and the run still passes.
  await withRepo({ "src/a.ts": clean }, async (dir) => {
    await git(dir, "add", "-A");
    await rm(path.join(dir, "src/a.ts"));
    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.doesNotMatch(result.stdout, /staged lint/);
    assert.match(result.stdout, /staged format \(1 file\)/);
  });
});

test("staged still checks the files that remain when another is missing", async () => {
  await withRepo({ "src/a.ts": clean, "src/b.ts": lintError }, async (dir) => {
    await git(dir, "add", "-A");
    await rm(path.join(dir, "src/a.ts"));
    const result = await arch(dir, "staged", "--no-arch");
    assert.equal(result.code, 1);
    assert.match(result.stdout, /no-unused-vars/);
  });
});

test("a real commit is blocked by the pre-commit hook for a partially staged file", async () => {
  await withRepo({ "src/a.ts": clean }, async (dir) => {
    await linkCli(dir);
    await arch(dir, "hooks", "install");
    await git(dir, "add", "-A");
    assert.equal((await git(dir, "commit", "-m", "feat: add a")).code, 0);

    await write(dir, { "src/a.ts": lintError });
    await git(dir, "add", "src/a.ts");
    await write(dir, { "src/a.ts": "export const a = 3;\n" });
    const blocked = await git(dir, "commit", "-m", "fix: change a");
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /not staged.*src\/a\.ts/);
    assert.equal(
      (await git(dir, "rev-list", "--count", "HEAD")).stdout.trim(),
      "1"
    );

    // commit -a stages the working tree copy first, so nothing is partial then.
    assert.equal(
      (await git(dir, "commit", "-a", "-m", "fix: change a")).code,
      0
    );
  });
});

const HOOKS = ["pre-commit", "pre-push", "commit-msg"];

async function modeOf(file) {
  return (await stat(file)).mode & 0o777;
}

test("hooks install writes the three hooks and points git at them", async () => {
  await withRepo({}, async (dir) => {
    const result = await arch(dir, "hooks", "install");
    assert.equal(result.code, 0, result.stderr);
    for (const name of HOOKS) {
      const file = path.join(dir, ".githooks", name);
      const text = await readFile(file, "utf8");
      assert.match(text, /^#!\/bin\/sh\n/);
      assert.match(text, /^set -e$/m);
      assert.equal(await modeOf(file), 0o755);
    }
    assert.equal(
      (await git(dir, "config", "--get", "core.hooksPath")).stdout.trim(),
      ".githooks"
    );
    assert.match(result.stdout, /core\.hooksPath set to \.githooks/);
  });
});

test("hooks install is idempotent", async () => {
  await withRepo({}, async (dir) => {
    await arch(dir, "hooks", "install");
    const before = await Promise.all(
      HOOKS.map((name) => readFile(path.join(dir, ".githooks", name), "utf8"))
    );
    const again = await arch(dir, "hooks", "install");
    assert.equal(again.code, 0, again.stderr);
    assert.equal(again.stdout.match(/^unchanged /gm)?.length, 3);
    const after = await Promise.all(
      HOOKS.map((name) => readFile(path.join(dir, ".githooks", name), "utf8"))
    );
    assert.deepEqual(after, before);
  });
});

test("hooks install restores the executable bit on an unchanged hook", async () => {
  await withRepo({}, async (dir) => {
    await arch(dir, "hooks", "install");
    const file = path.join(dir, ".githooks/pre-push");
    await chmod(file, 0o644);
    assert.equal((await arch(dir, "hooks", "install")).code, 0);
    assert.equal(await modeOf(file), 0o755);
  });
});

test("hooks install refuses a differing hook and names it, --force replaces it", async () => {
  await withRepo({}, async (dir) => {
    await arch(dir, "hooks", "install");
    const custom = path.join(dir, ".githooks/pre-commit");
    const original = await readFile(custom, "utf8");
    await writeFile(custom, "#!/bin/sh\necho mine\n");

    const refused = await arch(dir, "hooks", "install");
    assert.equal(refused.code, 1);
    assert.match(
      refused.stderr,
      /\.githooks\/pre-commit exists with different content/
    );
    assert.doesNotMatch(refused.stderr, /pre-push|commit-msg/);
    assert.equal(await readFile(custom, "utf8"), "#!/bin/sh\necho mine\n");

    const forced = await arch(dir, "hooks", "install", "--force");
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(forced.stdout, /overwrote \.githooks\/pre-commit/);
    assert.equal(await readFile(custom, "utf8"), original);
  });
});

test("hooks install writes nothing when any hook conflicts", async () => {
  await withRepo(
    { ".githooks/commit-msg": "#!/bin/sh\nexit 0\n" },
    async (dir) => {
      const result = await arch(dir, "hooks", "install");
      assert.equal(result.code, 1);
      await assert.rejects(stat(path.join(dir, ".githooks/pre-commit")));
      assert.notEqual(
        (await git(dir, "config", "--get", "core.hooksPath")).stdout.trim(),
        ".githooks"
      );
    }
  );
});

test("hooks install --husky writes .husky files and leaves git config alone", async () => {
  await withRepo({}, async (dir) => {
    const result = await arch(dir, "hooks", "install", "--husky");
    assert.equal(result.code, 0, result.stderr);
    for (const name of HOOKS) {
      const file = path.join(dir, ".husky", name);
      assert.match(await readFile(file, "utf8"), /^#!\/bin\/sh\n/);
      assert.equal(await modeOf(file), 0o755);
    }
    await assert.rejects(stat(path.join(dir, ".husky/_")));
    await assert.rejects(stat(path.join(dir, ".husky/husky.sh")));
    await assert.rejects(stat(path.join(dir, ".githooks")));
    assert.equal((await git(dir, "config", "--get", "core.hooksPath")).code, 1);
    const notes = result.stdout
      .split("\n")
      .filter((line) => line && !line.startsWith("wrote "));
    assert.equal(notes.length, 1, result.stdout);
    assert.match(notes[0], /once husky is installed/);
  });
});

test("hooks install --dir picks the directory", async () => {
  await withRepo({}, async (dir) => {
    const result = await arch(dir, "hooks", "install", "--dir", "tools/hooks");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await modeOf(path.join(dir, "tools/hooks/commit-msg")), 0o755);
    assert.equal(
      (await git(dir, "config", "--get", "core.hooksPath")).stdout.trim(),
      "tools/hooks"
    );
  });
});

const hooksPathOf = async (dir) =>
  (await git(dir, "config", "--get", "core.hooksPath")).stdout.trim();

test("hooks install refuses to take over a core.hooksPath that points elsewhere, --force replaces it", async () => {
  await withRepo({}, async (dir) => {
    await git(dir, "config", "core.hooksPath", "custom-hooks");

    const refused = await arch(dir, "hooks", "install");
    assert.equal(refused.code, 1);
    assert.match(
      refused.stderr,
      /core\.hooksPath is already set to custom-hooks/
    );
    assert.equal(await hooksPathOf(dir), "custom-hooks");
    await assert.rejects(stat(path.join(dir, ".githooks")));

    const forced = await arch(dir, "hooks", "install", "--force");
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(
      forced.stdout,
      /core\.hooksPath set to \.githooks \(was custom-hooks\)/
    );
    assert.equal(await hooksPathOf(dir), ".githooks");

    // Now it already points here, so a plain install goes through again.
    assert.equal((await arch(dir, "hooks", "install")).code, 0);
  });
});

test("hooks install accepts a core.hooksPath that already resolves to the target directory", async () => {
  await withRepo({}, async (dir) => {
    for (const value of [
      "./.githooks",
      ".githooks/",
      path.join(dir, ".githooks"),
    ]) {
      await git(dir, "config", "core.hooksPath", value);
      const result = await arch(dir, "hooks", "install");
      assert.equal(result.code, 0, `${value}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /\(was /);
    }
  });
});

test("hooks install --dir refuses when core.hooksPath points at another directory", async () => {
  await withRepo({}, async (dir) => {
    await arch(dir, "hooks", "install");
    const result = await arch(dir, "hooks", "install", "--dir", "tools/hooks");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already set to \.githooks/);
    await assert.rejects(stat(path.join(dir, "tools/hooks")));
    assert.equal(await hooksPathOf(dir), ".githooks");
  });
});

test("hooks install --husky warns on stderr when core.hooksPath points elsewhere", async () => {
  await withRepo({}, async (dir) => {
    await git(dir, "config", "core.hooksPath", "custom-hooks");
    const result = await arch(dir, "hooks", "install", "--husky");
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /core\.hooksPath is set to custom-hooks/);
    assert.match(result.stderr, /\.husky/);
    assert.equal(await hooksPathOf(dir), "custom-hooks");
    for (const name of HOOKS) {
      assert.equal(await modeOf(path.join(dir, ".husky", name)), 0o755);
    }
  });
});

test("hooks install --husky stays quiet when git reads .husky through husky's own path", async () => {
  await withRepo({}, async (dir) => {
    await git(dir, "config", "core.hooksPath", ".husky/_");
    const result = await arch(dir, "hooks", "install", "--husky");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
  });
  await withRepo({}, async (dir) => {
    const result = await arch(dir, "hooks", "install", "--husky");
    assert.equal(result.stderr, "");
  });
});

test("hooks install in a linked worktree will not rewrite the shared config for a directory outside it", async () => {
  await withRepo({}, async (dir) => {
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "feat: first");
    const worktree = `${dir}-linked`;
    const outside = path.join(scratch, `outside-${path.basename(dir)}`);
    try {
      assert.equal(
        (await git(dir, "worktree", "add", "-q", "--detach", worktree)).code,
        0
      );

      const refused = await arch(
        worktree,
        "hooks",
        "install",
        "--dir",
        outside
      );
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /linked worktree/);
      assert.equal(
        (await git(dir, "config", "--get", "core.hooksPath")).code,
        1
      );
      await assert.rejects(stat(outside));

      const forced = await arch(
        worktree,
        "hooks",
        "install",
        "--dir",
        outside,
        "--force"
      );
      assert.equal(forced.code, 0, forced.stderr);
      assert.equal(await hooksPathOf(dir), outside);
    } finally {
      await rm(worktree, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("hooks install in the main checkout may use a directory outside it", async () => {
  await withRepo({}, async (dir) => {
    const outside = path.join(scratch, `outside-main-${path.basename(dir)}`);
    try {
      const result = await arch(dir, "hooks", "install", "--dir", outside);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(await hooksPathOf(dir), outside);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("hooks flags that need a value do not swallow the next flag", async () => {
  await withRepo({}, async (dir) => {
    for (const args of [
      ["install", "--dir", "--force"],
      ["install", "--runner", "--husky"],
      ["install", "--dir="],
      ["status", "--dir", "--husky"],
      ["status", "--runner", "--dir"],
    ]) {
      const result = await arch(dir, "hooks", ...args);
      assert.equal(result.code, 2, `${args}: ${result.stdout}`);
      assert.match(result.stderr, /requires a value/);
    }
    await assert.rejects(stat(path.join(dir, "--force")));
    await assert.rejects(stat(path.join(dir, ".githooks")));
    // A value that starts with a dash is still possible in the = form.
    assert.equal((await arch(dir, "hooks", "install", "--dir=-odd")).code, 0);
    assert.equal(await modeOf(path.join(dir, "-odd/commit-msg")), 0o755);
  });
});

test("hooks install chooses the runner from the lockfile", async () => {
  const cases = [
    [{}, "npx --no-install arch-lint"],
    [{ "package-lock.json": "{}\n" }, "npx --no-install arch-lint"],
    [{ "bun.lock": "" }, "bunx --no-install arch-lint"],
    [{ "bun.lockb": "" }, "bunx --no-install arch-lint"],
    [{ "pnpm-lock.yaml": "" }, "pnpm exec arch-lint"],
  ];
  for (const [files, expected] of cases) {
    await withRepo(files, async (dir) => {
      assert.equal((await arch(dir, "hooks", "install")).code, 0);
      for (const name of HOOKS) {
        const text = await readFile(path.join(dir, ".githooks", name), "utf8");
        assert.ok(text.includes(expected), `${Object.keys(files)} ${name}`);
      }
    });
  }
});

test("hooks install --runner overrides the lockfile and rejects unknown runners", async () => {
  await withRepo({ "bun.lock": "" }, async (dir) => {
    assert.equal(
      (await arch(dir, "hooks", "install", "--runner", "pnpm")).code,
      0
    );
    const text = await readFile(path.join(dir, ".githooks/commit-msg"), "utf8");
    assert.match(text, /^pnpm exec arch-lint commit-msg "\$1"$/m);
    assert.equal(
      (await arch(dir, "hooks", "install", "--runner=yarn")).code,
      2
    );
    assert.equal((await arch(dir, "hooks", "install", "--runner")).code, 2);
  });
});

test("hooks install writes the pre-commit and commit-msg commands", async () => {
  await withRepo(
    {
      "arch-lint.config.json": json({
        hooks: { preCommit: ["node scripts/audit.mjs", "echo done"] },
      }),
    },
    async (dir) => {
      await arch(dir, "hooks", "install");
      const pre = await readFile(
        path.join(dir, ".githooks/pre-commit"),
        "utf8"
      );
      const lines = pre.split("\n");
      assert.deepEqual(lines.slice(-4), [
        "npx --no-install arch-lint staged",
        "node scripts/audit.mjs",
        "echo done",
        "",
      ]);
      const msg = await readFile(
        path.join(dir, ".githooks/commit-msg"),
        "utf8"
      );
      assert.match(msg, /^npx --no-install arch-lint commit-msg "\$1"$/m);
    }
  );
});

test("pre-push without migrations reads the refs, then checks and runs project commands", async () => {
  await withRepo(
    {
      "arch-lint.config.json": json({
        hooks: { prePush: ["npm test"] },
      }),
    },
    async (dir) => {
      await arch(dir, "hooks", "install");
      const text = await readFile(path.join(dir, ".githooks/pre-push"), "utf8");
      assert.match(text, /^refs=\$\(cat\)$/m);
      assert.doesNotMatch(text, /git fetch/);
      assert.doesNotMatch(text, /--journal/);
      assert.deepEqual(text.split("\n").slice(-3), [
        "npx --no-install arch-lint check",
        "npm test",
        "",
      ]);
      assert.ok(text.indexOf("refs=$(cat)") < text.indexOf("arch-lint check"));
    }
  );
});

test("pre-push with migrations fetches the base ref, then pipes the refs into the journal check", async () => {
  await withRepo(
    {
      "arch-lint.config.json": json({ migrations: { dir: "db/migrations" } }),
    },
    async (dir) => {
      await arch(dir, "hooks", "install");
      const text = await readFile(path.join(dir, ".githooks/pre-push"), "utf8");
      const fetch =
        "if ! git fetch --no-tags --quiet origin +refs/heads/main:refs/remotes/origin/main; then";
      const journal =
        "printf '%s\\n' \"$refs\" | npx --no-install arch-lint arch --journal $base_flag";
      assert.ok(text.includes(fetch), text);
      assert.ok(text.includes(journal), text);
      const order = ["refs=$(cat)", fetch, journal, "arch-lint check"].map(
        (part) => text.indexOf(part)
      );
      assert.deepEqual(
        order,
        [...order].sort((a, b) => a - b)
      );
      assert.ok(order.every((index) => index >= 0));
    }
  );
});

test("pre-push builds the fetch from baseRef and releaseRef", async () => {
  await withRepo(
    {
      "arch-lint.config.json": json({
        migrations: {
          journal: "db/_journal.json",
          baseRef: "upstream/release",
          releaseRef: "refs/heads/release",
        },
      }),
    },
    async (dir) => {
      await arch(dir, "hooks", "install");
      const text = await readFile(path.join(dir, ".githooks/pre-push"), "utf8");
      assert.match(
        text,
        /^if ! git fetch --no-tags --quiet upstream \+refs\/heads\/release:refs\/remotes\/upstream\/release; then$/m
      );
      assert.match(
        text,
        /^ {2}git ls-remote --exit-code --heads upstream refs\/heads\/release >\/dev\/null/m
      );
      assert.match(
        text,
        /rev-parse --verify --quiet refs\/remotes\/upstream\/release/
      );
    }
  );
});

test("hooks install rejects a malformed hooks config and unsafe refs", async () => {
  await withRepo(
    { "arch-lint.config.json": json({ hooks: { preCommit: "npm test" } }) },
    async (dir) => {
      const result = await arch(dir, "hooks", "install");
      assert.equal(result.code, 2);
      assert.match(result.stderr, /hooks\.preCommit/);
    }
  );
  await withRepo(
    {
      "arch-lint.config.json": json({
        migrations: { dir: "db", baseRef: "origin/main; rm -rf ." },
      }),
    },
    async (dir) => assert.equal((await arch(dir, "hooks", "install")).code, 2)
  );
});

test("hooks install needs the repository root", async () => {
  await withRepo({ "packages/app/.keep": "" }, async (dir) => {
    const inner = path.join(dir, "packages/app");
    const result = await arch(inner, "hooks", "install");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /repository root/);
  });
  await withDir({}, async (dir) => {
    assert.equal((await arch(dir, "hooks", "install")).code, 2);
  });
});

test("hooks rejects an unknown subcommand and flag", async () => {
  await withRepo({}, async (dir) => {
    assert.equal((await arch(dir, "hooks")).code, 2);
    assert.equal((await arch(dir, "hooks", "remove")).code, 2);
    assert.equal((await arch(dir, "hooks", "install", "--nope")).code, 2);
  });
});

test("hooks status reports missing, current and differing hooks and exits 1 until all is in place", async () => {
  await withRepo({}, async (dir) => {
    const before = await arch(dir, "hooks", "status");
    assert.equal(before.code, 1, before.stderr);
    assert.match(before.stdout, /core\.hooksPath: not set/);
    assert.match(before.stdout, /pre-commit: missing/);
    assert.match(before.stdout, /does not run|do not run/);

    await arch(dir, "hooks", "install");
    const after = await arch(dir, "hooks", "status");
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.match(after.stdout, /core\.hooksPath: \.githooks/);
    assert.match(after.stdout, /hooks directory: \.githooks/);
    for (const name of HOOKS) {
      assert.match(after.stdout, new RegExp(`^${name}: up to date$`, "m"));
    }
    assert.doesNotMatch(after.stdout, /do not run/);

    await writeFile(
      path.join(dir, ".githooks/pre-push"),
      "#!/bin/sh\nexit 0\n"
    );
    const edited = await arch(dir, "hooks", "status");
    assert.equal(edited.code, 1);
    assert.match(
      edited.stdout,
      /^pre-push: differs from what install would write$/m
    );
    assert.match(edited.stdout, /^pre-commit: up to date$/m);

    await writeFile(
      path.join(dir, "arch-lint.config.json"),
      json({ hooks: { preCommit: ["echo new"] } })
    );
    await arch(dir, "hooks", "install", "--force");
    assert.equal((await arch(dir, "hooks", "status")).code, 0);
    await writeFile(
      path.join(dir, "arch-lint.config.json"),
      json({ hooks: { preCommit: ["echo newer"] } })
    );
    const stale = await arch(dir, "hooks", "status");
    assert.equal(stale.code, 1);
    assert.match(stale.stdout, /^pre-commit: differs/m);
  });
});

test("hooks status exits 1 for a missing or non-executable hook and for a directory git does not read", async () => {
  await withRepo({}, async (dir) => {
    await arch(dir, "hooks", "install");
    assert.equal((await arch(dir, "hooks", "status")).code, 0);

    await chmod(path.join(dir, ".githooks/commit-msg"), 0o644);
    const loose = await arch(dir, "hooks", "status");
    assert.equal(loose.code, 1);
    assert.match(loose.stdout, /^commit-msg: not executable$/m);
    await chmod(path.join(dir, ".githooks/commit-msg"), 0o755);

    await rm(path.join(dir, ".githooks/pre-push"));
    const gone = await arch(dir, "hooks", "status");
    assert.equal(gone.code, 1);
    assert.match(gone.stdout, /^pre-push: missing$/m);
    await arch(dir, "hooks", "install");
    assert.equal((await arch(dir, "hooks", "status")).code, 0);

    // Every hook is current, but git reads another directory.
    await git(dir, "config", "core.hooksPath", "elsewhere");
    const away = await arch(dir, "hooks", "status", "--dir", ".githooks");
    assert.equal(away.code, 1);
    assert.match(away.stdout, /^core\.hooksPath: elsewhere$/m);
    assert.match(away.stdout, /git is not reading this directory/);
    assert.match(away.stdout, /^pre-commit: up to date$/m);

    await git(dir, "config", "--unset", "core.hooksPath");
    const unset = await arch(dir, "hooks", "status", "--dir", ".githooks");
    assert.equal(unset.code, 1);
    assert.match(unset.stdout, /core\.hooksPath: not set/);
  });
});

test("hooks status --husky inspects .husky and wants git to read it", async () => {
  await withRepo({}, async (dir) => {
    await arch(dir, "hooks", "install", "--husky");
    const result = await arch(dir, "hooks", "status", "--husky");
    assert.match(result.stdout, /hooks directory: \.husky/);
    assert.match(result.stdout, /^commit-msg: up to date$/m);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /git is not reading this directory/);

    // husky points git at .husky/_, which counts as reading .husky.
    await git(dir, "config", "core.hooksPath", ".husky/_");
    const active = await arch(dir, "hooks", "status", "--husky");
    assert.equal(active.code, 0, active.stdout + active.stderr);
    assert.doesNotMatch(active.stdout, /not reading/);
  });
});

test("a real commit is blocked by the commit-msg hook for a bad message and allowed for a good one", async () => {
  await withRepo({ "src/a.ts": clean }, async (dir) => {
    await linkCli(dir);
    assert.equal((await arch(dir, "hooks", "install")).code, 0);
    await git(dir, "add", "src/a.ts");

    const blocked = await git(dir, "commit", "-m", "Added a file.");
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stderr, /commit-msg: header must look like/);
    assert.notEqual((await git(dir, "rev-parse", "--verify", "HEAD")).code, 0);

    const allowed = await git(dir, "commit", "-m", "feat: add a file");
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
    assert.equal(
      (await git(dir, "log", "-1", "--format=%s")).stdout.trim(),
      "feat: add a file"
    );
  });
});

test("a real commit is blocked by the pre-commit hook for a staged lint error", async () => {
  await withRepo({ "src/a.ts": clean }, async (dir) => {
    await linkCli(dir);
    await arch(dir, "hooks", "install");
    await git(dir, "add", "src/a.ts");
    assert.equal((await git(dir, "commit", "-m", "feat: add a")).code, 0);

    await write(dir, { "src/b.ts": lintError });
    await git(dir, "add", "src/b.ts");
    const blocked = await git(dir, "commit", "-m", "fix: add b");
    assert.notEqual(blocked.code, 0);
    assert.match(blocked.stdout + blocked.stderr, /no-unused-vars/);
    assert.equal(
      (await git(dir, "rev-list", "--count", "HEAD")).stdout.trim(),
      "1"
    );
  });
});

test("the pre-commit hook runs the project's own commands after the staged check", async () => {
  await withRepo(
    {
      "src/a.ts": clean,
      "arch-lint.config.json": config({
        hooks: { preCommit: ["echo ran > extra.marker"] },
      }),
    },
    async (dir) => {
      await linkCli(dir);
      await arch(dir, "hooks", "install");
      await git(dir, "add", "src/a.ts");
      assert.equal((await git(dir, "commit", "-m", "feat: add a")).code, 0);
      assert.equal(
        await readFile(path.join(dir, "extra.marker"), "utf8"),
        "ran\n"
      );
    }
  );
});

test("a real push runs the pre-push hook with git's ref lines on stdin", async () => {
  await withRepo(
    {
      "src/a.ts": clean,
      "arch-lint.config.json": config({
        hooks: { prePush: ['printf "%s" "$refs" > pushed.marker'] },
      }),
    },
    async (dir) => {
      await linkCli(dir);
      const remote = path.join(scratch, `remote-${path.basename(dir)}.git`);
      await spawnIn("git", ["init", "-q", "--bare", remote], scratch);
      await git(dir, "remote", "add", "origin", remote);
      await arch(dir, "hooks", "install");
      await git(dir, "add", "src/a.ts", "package.json", ".gitignore");
      assert.equal(
        (await git(dir, "commit", "-m", "feat: first")).code,
        0,
        "commit"
      );

      const pushed = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.equal(pushed.code, 0, pushed.stdout + pushed.stderr);
      const refs = await readFile(path.join(dir, "pushed.marker"), "utf8");
      assert.match(refs, /^HEAD [0-9a-f]{40} refs\/heads\/main 0{40}$/);
      await rm(remote, { recursive: true, force: true });
    }
  );
});

const JOURNAL = "db/migrations/meta/_journal.json";
const migrationConfig = () =>
  config({
    migrations: { journal: JOURNAL },
    rules: {
      "migration-journal-order": "error",
      "migration-released-immutable": "error",
    },
  });

const journalText = (...whens) =>
  json({
    version: "7",
    dialect: "postgresql",
    entries: whens.map((when, idx) => ({
      idx,
      version: "7",
      when,
      tag: `000${idx}_m`,
      breakpoints: true,
    })),
  });

// The project-wide format check in the hook would otherwise trip over how JSON.stringify lays the journal out.
async function writeJournal(dir, ...whens) {
  await write(dir, { [JOURNAL]: journalText(...whens) });
  assert.equal((await arch(dir, "format:write", JOURNAL)).code, 0);
}

async function bareRemote(dir) {
  const remote = path.join(scratch, `remote-${path.basename(dir)}.git`);
  await spawnIn("git", ["init", "-q", "--bare", remote], scratch);
  await git(dir, "remote", "add", "origin", remote);
  return remote;
}

const remoteMain = async (remote) =>
  (
    await git(
      scratch,
      "--git-dir",
      remote,
      "rev-parse",
      "--verify",
      "refs/heads/main"
    )
  ).stdout.trim();

const head = async (dir) => (await git(dir, "rev-parse", "HEAD")).stdout.trim();

// The first push to an empty remote has no base to compare with, so the remote is seeded without the hook.
async function seedRemote(dir) {
  await git(dir, "add", "-A");
  assert.equal((await git(dir, "commit", "-m", "feat: first")).code, 0);
  const seeded = await git(
    dir,
    "push",
    "--no-verify",
    "origin",
    "HEAD:refs/heads/main"
  );
  assert.equal(seeded.code, 0, seeded.stderr);
}

test("a real push to main is blocked by the journal check for an out-of-order journal and passes with a valid one", async () => {
  await withRepo(
    {
      "src/a.ts": clean,
      [JOURNAL]: journalText(100, 200),
      "arch-lint.config.json": migrationConfig(),
    },
    async (dir) => {
      await linkCli(dir);
      const remote = await bareRemote(dir);
      await arch(dir, "hooks", "install");
      await seedRemote(dir);
      const seeded = await remoteMain(remote);
      assert.match(seeded, /^[0-9a-f]{40}$/);

      await writeJournal(dir, 100, 200, 50);
      await git(dir, "add", "-A");
      assert.equal(
        (await git(dir, "commit", "--no-verify", "-m", "feat: add a migration"))
          .code,
        0
      );
      const blocked = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.notEqual(blocked.code, 0, blocked.stdout + blocked.stderr);
      assert.match(
        blocked.stderr,
        /_journal\.json {2}migration-journal-order {2}Journal when not strictly increasing at 0002_m/
      );
      assert.equal(await remoteMain(remote), seeded);

      await writeJournal(dir, 100, 200, 300);
      await git(dir, "add", "-A");
      assert.equal(
        (await git(dir, "commit", "-m", "fix: order the journal")).code,
        0
      );
      const passed = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.equal(passed.code, 0, passed.stdout + passed.stderr);
      assert.doesNotMatch(passed.stderr, /migration-journal-order/);
      assert.equal(await remoteMain(remote), await head(dir));
      await rm(remote, { recursive: true, force: true });
    }
  );
});

test("the journal check only applies to pushes of main", async () => {
  await withRepo(
    {
      "src/a.ts": clean,
      [JOURNAL]: journalText(100, 200),
      // The working tree order check is off so the hook's own check passes and only the push step can object.
      "arch-lint.config.json": config({
        migrations: { journal: JOURNAL },
        rules: {
          "migration-journal-order": {
            level: "error",
            options: { workingTree: false },
          },
        },
      }),
    },
    async (dir) => {
      await linkCli(dir);
      const remote = await bareRemote(dir);
      await arch(dir, "hooks", "install");
      await seedRemote(dir);
      await writeJournal(dir, 100, 200, 50);
      await git(dir, "add", "-A");
      assert.equal(
        (await git(dir, "commit", "--no-verify", "-m", "feat: add a migration"))
          .code,
        0
      );

      const topic = await git(dir, "push", "origin", "HEAD:refs/heads/topic");
      assert.equal(topic.code, 0, topic.stdout + topic.stderr);
      const main = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.notEqual(main.code, 0, main.stdout + main.stderr);
      assert.match(
        main.stderr,
        /migration-journal-order {2}Journal when not strictly/
      );
      await rm(remote, { recursive: true, force: true });
    }
  );
});

test("a real push is blocked when arch-lint check fails inside the pre-push hook", async () => {
  await withRepo(
    {
      "src/a.ts": clean,
      "arch-lint.config.json": config({
        hooks: { prePush: ["echo ran > pushed.marker"] },
      }),
    },
    async (dir) => {
      await linkCli(dir);
      const remote = await bareRemote(dir);
      await arch(dir, "hooks", "install");
      await git(dir, "add", "-A");
      assert.equal((await git(dir, "commit", "-m", "feat: first")).code, 0);

      await write(dir, { "src/b.ts": lintError });
      await git(dir, "add", "src/b.ts");
      assert.equal(
        (await git(dir, "commit", "--no-verify", "-m", "feat: add b")).code,
        0
      );
      const blocked = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.notEqual(blocked.code, 0, blocked.stdout + blocked.stderr);
      assert.match(blocked.stdout + blocked.stderr, /no-unused-vars/);
      assert.match(blocked.stdout + blocked.stderr, /src\/b\.ts/);
      assert.equal(await remoteMain(remote), "");
      // set -e stops the hook at the failing check, so the project's own command never ran.
      await assert.rejects(stat(path.join(dir, "pushed.marker")));

      await write(dir, { "src/b.ts": clean });
      await git(dir, "add", "src/b.ts");
      assert.equal((await git(dir, "commit", "-m", "fix: clean b")).code, 0);
      const passed = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.equal(passed.code, 0, passed.stdout + passed.stderr);
      assert.equal(
        await readFile(path.join(dir, "pushed.marker"), "utf8"),
        "ran\n"
      );
      assert.equal(await remoteMain(remote), await head(dir));
      await rm(remote, { recursive: true, force: true });
    }
  );
});

test("pre-push to main falls back to the last fetched base with a note when the fetch fails", async () => {
  await withRepo(
    {
      "src/a.ts": clean,
      [JOURNAL]: journalText(100, 200),
      "arch-lint.config.json": migrationConfig(),
    },
    async (dir) => {
      await linkCli(dir);
      const remote = await bareRemote(dir);
      await arch(dir, "hooks", "install");
      await seedRemote(dir);
      // Fetching goes to a path that does not exist while pushing still reaches the real remote, which is how this stays offline-like.
      await git(
        dir,
        "remote",
        "set-url",
        "origin",
        path.join(scratch, "no-such-remote.git")
      );
      await git(dir, "remote", "set-url", "--push", "origin", remote);

      await writeJournal(dir, 100, 200, 300);
      await git(dir, "add", "-A");
      assert.equal(
        (await git(dir, "commit", "-m", "feat: add a migration")).code,
        0
      );
      const passed = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.equal(passed.code, 0, passed.stdout + passed.stderr);
      assert.match(
        passed.stderr,
        /pre-push: fetch failed, using the last fetched origin\/main/
      );
      assert.doesNotMatch(passed.stderr, /has no refs\/heads\/main yet/);
      assert.equal(await remoteMain(remote), await head(dir));

      // The stale base still protects released entries, so the journal check really read it.
      await writeJournal(dir, 100, 300);
      await git(dir, "add", "-A");
      assert.equal(
        (
          await git(
            dir,
            "commit",
            "--no-verify",
            "-m",
            "fix: change a released migration"
          )
        ).code,
        0
      );
      const blocked = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.notEqual(blocked.code, 0, blocked.stdout + blocked.stderr);
      assert.match(
        blocked.stderr,
        /fetch failed, using the last fetched origin\/main/
      );
      assert.match(blocked.stderr, /migration-released-immutable/);
      await rm(remote, { recursive: true, force: true });
    }
  );
});

// The first push to a remote that has no main yet: the hook is installed and nothing was seeded.
async function withFirstPush(files, fn) {
  await withRepo({ "src/a.ts": clean, ...files }, async (dir) => {
    await linkCli(dir);
    const remote = await bareRemote(dir);
    await arch(dir, "hooks", "install");
    try {
      await fn(dir, remote);
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });
}

const commitAll = async (dir, ...flags) => {
  await git(dir, "add", "-A");
  const done = await git(dir, "commit", ...flags, "-m", "feat: first");
  assert.equal(done.code, 0, done.stdout + done.stderr);
};

const NO_RELEASE_NOTE =
  /pre-push: origin has no refs\/heads\/main yet, so there is no released migration history to compare with/;

test("the first push of main to an empty remote passes with a valid journal and says why nothing was compared", async () => {
  await withFirstPush(
    {
      [JOURNAL]: journalText(100, 200),
      "arch-lint.config.json": migrationConfig(),
    },
    async (dir, remote) => {
      await commitAll(dir);
      const passed = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.equal(passed.code, 0, passed.stdout + passed.stderr);
      assert.match(passed.stderr, NO_RELEASE_NOTE);
      assert.doesNotMatch(passed.stderr, /fetch failed/);
      assert.doesNotMatch(passed.stderr, /Cannot read the migration journal/);
      assert.equal(await remoteMain(remote), await head(dir));
    }
  );
});

test("the first push of main to an empty remote still blocks an out-of-order journal", async () => {
  await withFirstPush(
    {
      [JOURNAL]: journalText(100, 200, 50),
      "arch-lint.config.json": migrationConfig(),
    },
    async (dir, remote) => {
      await commitAll(dir, "--no-verify");
      const blocked = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.notEqual(blocked.code, 0, blocked.stdout + blocked.stderr);
      assert.match(blocked.stderr, NO_RELEASE_NOTE);
      assert.match(
        blocked.stderr,
        /_journal\.json {2}migration-journal-order {2}Journal when not strictly increasing at 0002_m/
      );
      assert.doesNotMatch(blocked.stderr, /migration-released-immutable/);
      assert.equal(await remoteMain(remote), "");
    }
  );
});

test("the first push of main with requireBaseAlways still blocks, with a message that fits an empty remote", async () => {
  await withFirstPush(
    {
      [JOURNAL]: journalText(100, 200),
      "arch-lint.config.json": config({
        migrations: { journal: JOURNAL },
        rules: {
          "migration-journal-order": "error",
          "migration-released-immutable": {
            level: "error",
            options: { requireBaseAlways: true },
          },
        },
      }),
    },
    async (dir, remote) => {
      await commitAll(dir);
      const blocked = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.notEqual(blocked.code, 0, blocked.stdout + blocked.stderr);
      assert.match(blocked.stderr, NO_RELEASE_NOTE);
      assert.match(
        blocked.stderr,
        /The remote has no refs\/heads\/main yet, so origin\/main cannot be read, and migration-released-immutable sets requireBaseAlways/
      );
      assert.doesNotMatch(blocked.stderr, /fetch it and push again/);
      assert.equal(await remoteMain(remote), "");
    }
  );
});

test("an unreachable remote with no local base ref blocks and says it could not fetch", async () => {
  await withFirstPush(
    {
      [JOURNAL]: journalText(100, 200),
      "arch-lint.config.json": migrationConfig(),
    },
    async (dir, remote) => {
      await git(
        dir,
        "remote",
        "set-url",
        "origin",
        path.join(scratch, "no-such-remote.git")
      );
      await git(dir, "remote", "set-url", "--push", "origin", remote);
      await commitAll(dir);
      const blocked = await git(dir, "push", "origin", "HEAD:refs/heads/main");
      assert.notEqual(blocked.code, 0, blocked.stdout + blocked.stderr);
      assert.match(
        blocked.stderr,
        /pre-push: could not fetch origin and origin\/main does not exist locally/
      );
      assert.match(
        blocked.stderr,
        /Cannot read the migration journal at origin\/main; fetch it and push again/
      );
      assert.doesNotMatch(blocked.stderr, /using the last fetched/);
      assert.doesNotMatch(blocked.stderr, /has no refs\/heads\/main yet/);
      assert.equal(await remoteMain(remote), "");
    }
  );
});

test("the first push of a branch other than main is not held up by the missing release ref", async () => {
  await withFirstPush(
    {
      [JOURNAL]: journalText(100, 200, 50),
      // The working tree order check is off so only the push step could object, and it must not for a topic branch.
      "arch-lint.config.json": config({
        migrations: { journal: JOURNAL },
        rules: {
          "migration-journal-order": {
            level: "error",
            options: { workingTree: false },
          },
          "migration-released-immutable": "error",
        },
      }),
    },
    async (dir, remote) => {
      await commitAll(dir);
      const passed = await git(dir, "push", "origin", "HEAD:refs/heads/topic");
      assert.equal(passed.code, 0, passed.stdout + passed.stderr);
      assert.doesNotMatch(passed.stderr, /Cannot read the migration journal/);
      assert.doesNotMatch(passed.stderr, /migration-journal-order/);
      assert.equal(await remoteMain(remote), "");
      const topic = await git(
        scratch,
        "--git-dir",
        remote,
        "rev-parse",
        "refs/heads/topic"
      );
      assert.equal(topic.stdout.trim(), await head(dir));
    }
  );
});

const WORKFLOW = ".github/workflows/arch-lint.yml";

test("init --ci picks the install step from the lockfile", async () => {
  const cases = [
    [
      { "package-lock.json": "{}\n" },
      ["run: npm ci"],
      ["setup-bun", "corepack"],
    ],
    [
      { "pnpm-lock.yaml": "" },
      ["run: corepack enable", "run: pnpm install --frozen-lockfile"],
      ["setup-bun", "npm ci"],
    ],
    [
      { "bun.lock": "" },
      ["uses: oven-sh/setup-bun@v2", "run: bun install --frozen-lockfile"],
      ["corepack", "npm ci"],
    ],
    [
      { "bun.lockb": "" },
      ["uses: oven-sh/setup-bun@v2", "run: bun install --frozen-lockfile"],
      ["corepack", "npm ci"],
    ],
    [{}, ["run: npm install"], ["setup-bun", "corepack", "npm ci"]],
  ];
  for (const [files, present, absent] of cases) {
    await withRepo(files, async (dir) => {
      const result = await arch(dir, "init", "--ci");
      assert.equal(result.code, 0, result.stderr);
      const text = await readFile(path.join(dir, WORKFLOW), "utf8");
      for (const part of [
        "uses: actions/checkout@v4",
        "uses: actions/setup-node@v4",
        "node-version: 20",
        "run: npx arch-lint check",
        ...present,
      ]) {
        assert.ok(
          text.includes(part),
          `${Object.keys(files)} should have ${part}\n${text}`
        );
      }
      for (const part of absent) {
        assert.ok(
          !text.includes(part),
          `${Object.keys(files)} should not have ${part}`
        );
      }
      assert.ok(
        text.indexOf("actions/setup-node") < text.indexOf("arch-lint check")
      );
    });
  }
});

test("init --ci writes a workflow that Prettier parses and finds formatted", async () => {
  await withRepo({ "pnpm-lock.yaml": "" }, async (dir) => {
    await arch(dir, "init", "--ci");
    const result = await arch(dir, "format", WORKFLOW);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  });
});

test("init --ci fetches the migration base when migrations are configured", async () => {
  await withRepo(
    { "arch-lint.config.json": json({ migrations: { dir: "db" } }) },
    async (dir) => {
      await arch(dir, "init", "--ci");
      const text = await readFile(path.join(dir, WORKFLOW), "utf8");
      assert.match(
        text,
        /run: git fetch --no-tags --depth=1 origin \+refs\/heads\/main:refs\/remotes\/origin\/main/
      );
      assert.ok(text.indexOf("git fetch") < text.indexOf("arch-lint check"));
    }
  );
  await withRepo({}, async (dir) => {
    await arch(dir, "init", "--ci");
    assert.doesNotMatch(
      await readFile(path.join(dir, WORKFLOW), "utf8"),
      /git fetch/
    );
  });
});

test("init --ci will not overwrite a different workflow without --force", async () => {
  await withRepo({ [WORKFLOW]: "name: mine\n" }, async (dir) => {
    const refused = await arch(dir, "init", "--ci");
    assert.equal(refused.code, 1);
    assert.match(
      refused.stderr,
      /arch-lint\.yml exists with different content/
    );
    assert.equal(
      await readFile(path.join(dir, WORKFLOW), "utf8"),
      "name: mine\n"
    );

    const forced = await arch(dir, "init", "--ci", "--force");
    assert.equal(forced.code, 0, forced.stderr);
    assert.match(
      await readFile(path.join(dir, WORKFLOW), "utf8"),
      /npx arch-lint check/
    );

    const again = await arch(dir, "init", "--ci");
    assert.equal(again.code, 0);
    assert.match(again.stdout, /unchanged \.github\/workflows\/arch-lint\.yml/);
  });
});

test("plain init writes no workflow and no hooks", async () => {
  await withRepo({}, async (dir) => {
    assert.equal((await arch(dir, "init")).code, 0);
    await assert.rejects(stat(path.join(dir, ".github")));
    await assert.rejects(stat(path.join(dir, ".githooks")));
  });
});

test("init --hooks also installs the hooks", async () => {
  await withRepo({}, async (dir) => {
    const result = await arch(dir, "init", "--hooks");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await modeOf(path.join(dir, ".githooks/commit-msg")), 0o755);
    assert.equal(
      (await git(dir, "config", "--get", "core.hooksPath")).stdout.trim(),
      ".githooks"
    );
    const pkg = JSON.parse(
      await readFile(path.join(dir, "package.json"), "utf8")
    );
    assert.equal(pkg.scripts.check, "arch-lint check");
  });
});

test("init --hooks forwards --husky, --dir, --runner and --force to the installer", async () => {
  await withRepo({}, async (dir) => {
    const result = await arch(dir, "init", "--hooks", "--husky");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await modeOf(path.join(dir, ".husky/commit-msg")), 0o755);
    await assert.rejects(stat(path.join(dir, ".githooks")));
    assert.equal((await git(dir, "config", "--get", "core.hooksPath")).code, 1);
  });
  await withRepo({}, async (dir) => {
    const result = await arch(
      dir,
      "init",
      "--hooks",
      "--dir",
      "tools/hooks",
      "--runner=pnpm"
    );
    assert.equal(result.code, 0, result.stderr);
    const text = await readFile(
      path.join(dir, "tools/hooks/commit-msg"),
      "utf8"
    );
    assert.match(text, /^pnpm exec arch-lint commit-msg "\$1"$/m);
    assert.equal(await hooksPathOf(dir), "tools/hooks");
    await assert.rejects(stat(path.join(dir, ".githooks")));
  });
  await withRepo(
    { ".githooks/pre-commit": "#!/bin/sh\necho mine\n" },
    async (dir) => {
      const refused = await arch(dir, "init", "--hooks");
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /pre-commit exists with different content/);
      const forced = await arch(dir, "init", "--hooks", "--force");
      assert.equal(forced.code, 0, forced.stderr);
      assert.match(forced.stdout, /overwrote \.githooks\/pre-commit/);
    }
  );
});

test("init --hooks rejects a value flag with no value before it writes anything", async () => {
  await withRepo({}, async (dir) => {
    const result = await arch(dir, "init", "--hooks", "--dir", "--force");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--dir requires a value/);
    const pkg = JSON.parse(
      await readFile(path.join(dir, "package.json"), "utf8")
    );
    assert.equal(pkg.scripts, undefined);
    await assert.rejects(stat(path.join(dir, "--force")));
  });
});
