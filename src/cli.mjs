import { readFileSync } from "node:fs";
import path from "node:path";
import { arch } from "./commands/arch.mjs";
import { check } from "./commands/check.mjs";
import { codeflow } from "./commands/codeflow.mjs";
import { commitMsg } from "./commands/commit-msg.mjs";
import { format } from "./commands/format.mjs";
import { hooks } from "./commands/hooks.mjs";
import { init } from "./commands/init.mjs";
import { lint } from "./commands/lint.mjs";
import { PYTHON_FLAGS } from "./commands/python.mjs";
import { staged } from "./commands/staged.mjs";
import {
  ESLINT_VALUE_FLAGS,
  PKG_ROOT,
  UsageError,
  positionals,
} from "./util.mjs";

const HELP = `arch-lint: ESLint, Prettier, architecture rules and CodeFlow in one install

Usage: arch-lint [--cwd <dir>] <command> [args]

Commands:
  lint [paths] [eslint flags]   ESLint with the bundled config (or your eslint.config.*), ruff and mypy for Python projects
  format [paths]                Prettier check, ruff format --check
  format:write [paths]          Prettier write, ruff format
  fix                           lint --fix, then format:write
  arch [--list|--all|--rule id]  Architecture rules (config: arch-lint.config.json)
  check [--skip-arch]           lint + format + arch, one exit code for CI
  codeflow [analyze|verify|audit|test]  Headless CodeFlow: analysis, report, hotspots, finding checks
  staged [--fix] [--no-arch] [--allow-partial]  Check the staged files with lint and format, then the architecture rules
  commit-msg <file>             Check a commit message (conventional commits), for the commit-msg hook
  hooks install|status          Write or inspect the git hooks (--husky, --dir, --force, --runner)
  init [--force] [--ci] [--hooks]  Add scripts and arch-lint.config.json; --ci writes a workflow, --hooks installs git hooks

Options:
  --cwd <dir>                   Run against another project directory
  --no-python, --python-only    With lint, format, format:write, fix, check: leave Python out, or run only Python
  -h, --help                    Show this help
  -v, --version                 Show the version
`;

function pullGlobalFlags(argv) {
  const rest = [...argv];
  let cwd = process.cwd();
  const i = rest.findIndex(
    (arg) => arg === "--cwd" || arg.startsWith("--cwd=")
  );
  if (i >= 0) {
    const inline = rest[i].startsWith("--cwd=");
    const value = inline ? rest[i].slice("--cwd=".length) : rest[i + 1];
    if (!value) throw new UsageError("--cwd requires a value");
    cwd = path.resolve(value);
    rest.splice(i, inline ? 1 : 2);
  }
  return { cwd, rest };
}

export async function main(argv) {
  const { cwd, rest } = pullGlobalFlags(argv);
  const [command, ...args] = rest;
  const ctx = { root: cwd };

  if (
    !command ||
    command === "-h" ||
    command === "--help" ||
    command === "help"
  ) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version") {
    const pkg = JSON.parse(
      readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")
    );
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  switch (command) {
    case "lint":
      return lint(args, ctx);
    case "format":
      return format(args, { ...ctx, write: args.includes("--write") });
    case "format:write":
      return format(
        args.filter((a) => a !== "--write"),
        { ...ctx, write: true }
      );
    case "fix": {
      const linted = await lint(["--fix", ...args], ctx);
      const formatted = await format(
        [
          ...args.filter((a) => PYTHON_FLAGS.includes(a)),
          ...positionals(args, ESLINT_VALUE_FLAGS),
        ],
        { ...ctx, write: true }
      );
      return linted || formatted;
    }
    case "arch":
      return arch(args, ctx);
    case "check":
      return check(args, ctx);
    case "codeflow":
      return codeflow(args, ctx);
    case "staged":
      return staged(args, ctx);
    case "commit-msg":
      return commitMsg(args, ctx);
    case "hooks":
      return hooks(args, ctx);
    case "init":
      return init(args, ctx);
    default:
      throw new UsageError(
        `Unknown command "${command}". Run arch-lint --help.`
      );
  }
}

export async function runCli(argv) {
  try {
    process.exitCode = await main(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`arch-lint: ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
}
