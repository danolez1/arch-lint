// Local release gate: run it before `npm publish`, and let `prepublishOnly` run it again.
// Usage: node scripts/release-check.mjs [--skip-install]
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skipInstall = process.argv.includes("--skip-install");
const results = [];
// Built from char codes so this file itself carries no en or em dash.
const dashes = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);
// A dry run of the publish must not turn the nested pack and install into no-ops.
const nestedEnv = { ...process.env, npm_config_dry_run: "false" };

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 28,
    env: nestedEnv,
    ...options,
  });
}

function step(name, fn) {
  process.stdout.write(`\n== ${name}\n`);
  let outcome;
  try {
    outcome = fn();
  } catch (err) {
    outcome = { ok: false, note: err.message };
  }
  results.push({ name, ...outcome });
  process.stdout.write(
    `${outcome.ok ? "ok" : "FAILED"}${outcome.note ? `: ${outcome.note}` : ""}\n`
  );
}

function npmScript(name) {
  return () => {
    const res = run("npm", ["run", name], {
      stdio: "inherit",
      encoding: undefined,
    });
    return {
      ok: res.status === 0,
      note: res.status === 0 ? "" : `exit ${res.status}`,
    };
  };
}

const tracked = () =>
  run("git", ["ls-files", "-z"]).stdout.split("\0").filter(Boolean);
const readTracked = (file) => {
  try {
    return readFileSync(path.join(root, file), "utf8");
  } catch {
    return null;
  }
};

step("working tree is clean and on a pushed commit", () => {
  const dirty = run("git", ["status", "--porcelain"]).stdout.trim();
  if (dirty) return { ok: false, note: `uncommitted changes:\n${dirty}` };
  const unpushed = run("git", ["log", "@{u}..HEAD", "--oneline"]);
  if (unpushed.status === 0 && unpushed.stdout.trim())
    return { ok: false, note: "commits not pushed yet" };
  // Without an upstream (a new branch, or a CI tag checkout) there is nothing to compare against.
  return {
    ok: true,
    note:
      unpushed.status === 0 ? "" : "no upstream branch, push state not checked",
  };
});

step("typecheck", npmScript("typecheck"));
step("lint", npmScript("lint"));
step("format", npmScript("format"));
step("tests", npmScript("test"));

step("package contents", () => {
  const res = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
  if (res.status !== 0) return { ok: false, note: res.stderr.trim() };
  const [info] = JSON.parse(res.stdout);
  const files = info.files.map((f) => f.path);
  const problems = [];
  for (const needed of [
    "src/bin.mjs",
    "package.json",
    "LICENSE",
    "README.md",
  ]) {
    if (!files.includes(needed)) problems.push(`missing ${needed}`);
  }
  const unwanted =
    /^(reference|tests|scripts|\.github|\.env)|\.tgz$|node_modules|\.test\.(m?js|ts)$/;
  for (const file of files)
    if (unwanted.test(file)) problems.push(`should not ship: ${file}`);
  if (info.size > 1_000_000)
    problems.push(`package is ${info.size} bytes, over 1 MB`);
  return problems.length > 0
    ? { ok: false, note: problems.join("; ") }
    : {
        ok: true,
        note: `${files.length} files, ${(info.size / 1024).toFixed(0)} kB packed`,
      };
});

step("text rules (phrase, dashes, private paths, secrets)", () => {
  const phrase = new RegExp(["open", "[ -]?", "source"].join(""), "i");
  const proseOnly =
    /^(README\.md|CHANGELOG\.md|CONTRIBUTING\.md|SECURITY\.md|CODE_OF_CONDUCT\.md|docs\/.*\.md)$/;
  const secrets = [
    /AKIA[0-9A-Z]{16}/,
    /gh[pousr]_[A-Za-z0-9]{30,}/,
    /sk-[A-Za-z0-9]{20,}/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /xox[baprs]-[A-Za-z0-9-]{10,}/,
    /npm_[A-Za-z0-9]{30,}/,
  ];
  const denylistFile = path.join(root, ".release-denylist");
  const denylist = existsSync(denylistFile)
    ? readFileSync(denylistFile, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => new RegExp(l, "i"))
    : [];
  const problems = [];
  for (const file of tracked()) {
    const text = readTracked(file);
    if (text === null || text.includes("\0")) continue;
    const upstream =
      file.startsWith("src/codeflow/") ||
      file.startsWith("tests/codeflow/") ||
      file.startsWith("tests/fixtures/");
    if (phrase.test(text)) problems.push(`${file}: contains the banned phrase`);
    if (/\/Users\/|\/home\/[a-z]/.test(text) && !upstream)
      problems.push(`${file}: absolute home path`);
    if (proseOnly.test(file) && dashes.test(text))
      problems.push(`${file}: em or en dash`);
    for (const pattern of secrets)
      if (pattern.test(text))
        problems.push(
          `${file}: looks like a secret (${pattern.source.slice(0, 20)})`
        );
    if (!upstream)
      for (const pattern of denylist)
        if (pattern.test(text))
          problems.push(`${file}: matches denylist ${pattern.source}`);
  }
  return problems.length > 0
    ? { ok: false, note: `\n  ${problems.join("\n  ")}` }
    : {
        ok: true,
        note:
          denylist.length > 0
            ? `${denylist.length} denylist patterns applied`
            : "no .release-denylist found, project name check skipped",
      };
});

step("version is unpublished", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const res = run("npm", ["view", `${pkg.name}@${pkg.version}`, "version"]);
  if (res.status === 0 && res.stdout.trim())
    return {
      ok: false,
      note: `${pkg.name}@${pkg.version} is already on the registry`,
    };
  if (/E404/.test(res.stderr))
    return { ok: true, note: `${pkg.name}@${pkg.version} is free` };
  return {
    ok: false,
    note: `registry lookup was inconclusive: ${res.stderr.trim().split("\n")[0]}`,
  };
});

if (!skipInstall) {
  step("clean export, install and run", () => {
    const work = mkdtempSync(path.join(tmpdir(), "arch-lint-release-"));
    try {
      const exported = path.join(work, "export");
      mkdirSync(exported);
      const archive = run("git", ["archive", "HEAD"], { encoding: "buffer" });
      if (archive.status !== 0)
        return { ok: false, note: "git archive HEAD failed" };
      const untar = spawnSync("tar", ["-x", "-C", exported], {
        input: archive.stdout,
      });
      if (untar.status !== 0)
        return { ok: false, note: "could not export HEAD" };
      const sh = (cmd, args, cwd) =>
        spawnSync(cmd, args, { cwd, encoding: "utf8", env: nestedEnv });
      if (sh("npm", ["ci"], exported).status !== 0)
        return { ok: false, note: "npm ci failed in the export" };
      const packed = sh(
        "npm",
        ["pack", "--pack-destination", work, "--json"],
        exported
      );
      if (packed.status !== 0)
        return { ok: false, note: "npm pack failed in the export" };
      const tarball = path.join(work, JSON.parse(packed.stdout)[0].filename);
      const managers = [["npm", ["install", "--save-dev"]]];
      if (sh("bun", ["--version"], work).status === 0)
        managers.push(["bun", ["add", "--dev"]]);
      for (const [name, installArgs] of managers) {
        const fixture = path.join(work, `fixture-${name}`);
        mkdirSync(path.join(fixture, "src"), { recursive: true });
        writeFileSync(
          path.join(fixture, "package.json"),
          '{\n  "name": "fixture",\n  "version": "1.0.0"\n}\n'
        );
        writeFileSync(
          path.join(fixture, "src", "a.ts"),
          "export const a = 1;\n"
        );
        if (sh(name, [...installArgs, tarball], fixture).status !== 0)
          return { ok: false, note: `${name} could not install the tarball` };
        const bin = path.join(fixture, "node_modules", ".bin", "arch-lint");
        for (const args of [["--version"], ["init"], ["check"]]) {
          const res = sh(bin, args, fixture);
          if (res.status !== 0)
            return {
              ok: false,
              note: `${name}: arch-lint ${args.join(" ")} exited ${res.status}\n${res.stdout}${res.stderr}`,
            };
        }
      }
      return {
        ok: true,
        note: `installed and ran under ${managers.map(([n]) => n).join(" and ")}`,
      };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
}

const failed = results.filter((r) => !r.ok);
process.stdout.write(
  `\n${results.length - failed.length} of ${results.length} checks passed\n`
);
if (failed.length > 0) {
  for (const r of failed) process.stdout.write(`  failed: ${r.name}\n`);
  process.exit(1);
}
