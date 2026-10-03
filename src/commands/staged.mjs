import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { stagedFiles, unstagedFiles } from "../git.mjs";
import { UsageError } from "../util.mjs";
import { arch } from "./arch.mjs";
import { format } from "./format.mjs";
import { lint } from "./lint.mjs";
import { pullPythonFlags } from "./python.mjs";

const LINT_FILE = /\.(?:[jt]sx?|[cm][jt]s)$/;
const PYTHON_FILE = /\.pyi?$/;

async function prettierSupport() {
  const { getSupportInfo } = await import("prettier");
  const { languages } = await getSupportInfo();
  const extensions = languages.flatMap((language) => language.extensions ?? []);
  const names = new Set(
    languages.flatMap((language) => language.filenames ?? [])
  );
  return (file) => {
    const base = path.basename(file);
    return names.has(base) || extensions.some((ext) => base.endsWith(ext));
  };
}

// A leading dash would otherwise be read as a flag by the tools.
const asArg = (file) => (file.startsWith("-") ? `./${file}` : file);

function snapshot(root, files) {
  const hashes = new Map();
  for (const file of files) {
    const abs = path.join(root, file);
    hashes.set(
      file,
      existsSync(abs)
        ? createHash("sha1").update(readFileSync(abs)).digest("hex")
        : null
    );
  }
  return hashes;
}

function parseArgs(argv) {
  const { rest, flags } = pullPythonFlags(argv);
  const opts = { fix: false, arch: true, allowPartial: false };
  for (const arg of rest) {
    if (arg === "--fix") opts.fix = true;
    else if (arg === "--no-arch") opts.arch = false;
    else if (arg === "--allow-partial") opts.allowPartial = true;
    else throw new UsageError(`staged: unknown argument "${arg}"`);
  }
  return { ...opts, flags, pythonOnly: flags.includes("--python-only") };
}

// lstat, so a staged symlink with a missing target still counts as present.
function presentOnDisk(root, file) {
  try {
    lstatSync(path.join(root, file));
    return true;
  } catch {
    return false;
  }
}

export async function staged(argv, ctx) {
  const opts = parseArgs(argv);
  const stagedList = stagedFiles(ctx.root);
  if (stagedList.length === 0) {
    process.stdout.write("arch-lint staged: no staged files\n");
    return 0;
  }

  // The tools read the working tree, so a deleted file has nothing to check.
  const files = stagedList.filter((file) => presentOnDisk(ctx.root, file));
  const missing = stagedList.filter((file) => !files.includes(file));
  if (missing.length > 0) {
    process.stderr.write(
      `arch-lint staged: skipped, staged but not in the working tree: ${missing.join(", ")}\n`
    );
  }

  const unstaged = new Set(unstagedFiles(ctx.root));
  const partial = files.filter((file) => unstaged.has(file));
  if (partial.length > 0) {
    if (!opts.allowPartial) {
      process.stderr.write(
        `arch-lint staged: these files have changes that are not staged, so the checks would not see what will be committed: ${partial.join(", ")}\nStage them (git add) or stash the rest (git stash --keep-index), or pass --allow-partial to check the working tree copies anyway.\n`
      );
      return 1;
    }
    process.stderr.write(
      `arch-lint staged: warning: checking the working tree copy of files with unstaged changes: ${partial.join(", ")}\n`
    );
  }

  const supported = await prettierSupport();
  const python = files.filter((file) => PYTHON_FILE.test(file));
  const lintTargets = [
    ...files.filter((file) => LINT_FILE.test(file)),
    ...python,
  ];
  const formatTargets = [
    ...files.filter((file) => !PYTHON_FILE.test(file) && supported(file)),
    ...python,
  ];

  const steps = [];
  if (lintTargets.length > 0) {
    steps.push([
      "lint",
      lintTargets.length,
      () =>
        lint(
          [
            ...opts.flags,
            ...(opts.fix ? ["--fix"] : []),
            "--no-error-on-unmatched-pattern",
            ...lintTargets.map(asArg),
          ],
          ctx
        ),
    ]);
  }
  if (formatTargets.length > 0) {
    steps.push([
      "format",
      formatTargets.length,
      () =>
        format([...opts.flags, ...formatTargets.map(asArg)], {
          ...ctx,
          write: opts.fix,
        }),
    ]);
  }

  const before = opts.fix ? snapshot(ctx.root, files) : null;
  const failed = [];
  for (const [name, count, step] of steps) {
    process.stdout.write(
      `\n== arch-lint staged ${name} (${count} ${count === 1 ? "file" : "files"})\n`
    );
    if ((await step()) !== 0) failed.push(name);
  }
  // The architecture rules only read JS and TS, so a Python-only run has nothing for them.
  if (opts.arch && !opts.pythonOnly) {
    process.stdout.write("\n== arch-lint staged arch\n");
    if ((await arch([], ctx)) !== 0) failed.push("arch");
  }

  if (before) {
    const after = snapshot(ctx.root, files);
    const changed = files.filter(
      (file) => before.get(file) !== after.get(file)
    );
    if (changed.length > 0) {
      process.stdout.write(
        `\nfixed in the working tree, not re-staged (run git add): ${changed.join(", ")}\n`
      );
    }
  }

  if (failed.length > 0) {
    process.stderr.write(`\narch-lint staged failed: ${failed.join(", ")}\n`);
    return 1;
  }
  process.stdout.write("\narch-lint staged passed\n");
  return 0;
}
