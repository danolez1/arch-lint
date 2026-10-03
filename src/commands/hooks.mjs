import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  baseFetch,
  canonicalPath,
  git,
  hooksPathSetting,
  isLinkedWorktree,
  migrationsConfigured,
  repoTopLevel,
} from "../git.mjs";
import { UsageError, detectLockfiles, readProjectConfig } from "../util.mjs";

const HOOK_NAMES = ["pre-commit", "pre-push", "commit-msg"];

const RUNNERS = {
  npx: "npx --no-install",
  bunx: "bunx --no-install",
  pnpm: "pnpm exec",
};

function detectRunner(root) {
  const lock = detectLockfiles(root);
  if (lock.bun) return "bunx";
  if (lock.pnpm) return "pnpm";
  return "npx";
}

const INSTALL_FLAGS = {
  booleans: ["--husky", "--force"],
  values: ["--dir", "--runner"],
};

function parseFlags(argv, { booleans, values }) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (booleans.includes(flag) && inline === undefined) {
      opts[flag.slice(2)] = true;
    } else if (values.includes(flag)) {
      // A following flag means the value was left out; --flag=-x still allows a value that starts with a dash.
      const value = inline ?? argv[++i];
      if (!value || (inline === undefined && value.startsWith("-"))) {
        throw new UsageError(`${flag} requires a value`);
      }
      opts[flag.slice(2)] = value;
    } else {
      throw new UsageError(`hooks: unknown argument "${argv[i]}"`);
    }
  }
  return opts;
}

function projectCommands(config, key) {
  const list = config.hooks?.[key] ?? [];
  if (
    !Array.isArray(list) ||
    list.some(
      (c) => typeof c !== "string" || c.trim() === "" || /[\r\n]/.test(c)
    )
  ) {
    throw new UsageError(
      `arch-lint.config.json: hooks.${key} must be an array of single line commands`
    );
  }
  return list;
}

const script = (lines) =>
  [
    "#!/bin/sh",
    "# Written by arch-lint hooks install. Change the commands in arch-lint.config.json and install again.",
    "set -e",
    ...lines,
    "",
  ].join("\n");

export function hookContents(root, runner) {
  const config = readProjectConfig(root);
  const cli = `${RUNNERS[runner]} arch-lint`;

  const pushLines = [
    "# git sends the ref lines once on stdin, so read them before another step can consume them.",
    "refs=$(cat)",
  ];
  if (migrationsConfigured(config)) {
    const fetch = baseFetch(config.migrations);
    if (fetch) {
      pushLines.push(
        "# Offline pushes still run the other checks; the migration check then reads the last fetched copy.",
        `git fetch --no-tags --quiet ${fetch.remote} ${fetch.refspec} || echo "pre-push: fetch failed, using the last fetched ${fetch.baseRef}" >&2`
      );
    }
    pushLines.push(`printf '%s\\n' "$refs" | ${cli} arch --journal`);
  }
  pushLines.push(`${cli} check`, ...projectCommands(config, "prePush"));

  return {
    "pre-commit": script([
      `${cli} staged`,
      ...projectCommands(config, "preCommit"),
    ]),
    "pre-push": script(pushLines),
    "commit-msg": script([`${cli} commit-msg "$1"`]),
  };
}

function runnerFor(root, opts) {
  const runner = opts.runner ?? detectRunner(root);
  if (!(runner in RUNNERS)) {
    throw new UsageError(
      `--runner must be one of: ${Object.keys(RUNNERS).join(", ")}`
    );
  }
  return runner;
}

const shown = (root, file) =>
  path.relative(root, file).split(path.sep).join("/");

const read = (file) => (existsSync(file) ? readFileSync(file, "utf8") : null);

const sameDir = (a, b) => canonicalPath(a) === canonicalPath(b);

// Husky points git at .husky/_, whose scripts then run the files in .husky.
const readsDir = (target, dir) =>
  sameDir(target, dir) ||
  (path.basename(target) === "_" && sameDir(path.dirname(target), dir));

const isOutside = (root, dir) => {
  const rel = path.relative(root, dir);
  return (
    rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
  );
};

// The install flags that init --hooks passes on, checked with the same rules as the installer.
export function installFlagsFrom(argv) {
  const picked = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (INSTALL_FLAGS.booleans.includes(flag)) {
      picked.push(argv[i]);
    } else if (INSTALL_FLAGS.values.includes(flag)) {
      picked.push(argv[i]);
      if (inline === undefined) picked.push(argv[++i] ?? "");
    }
  }
  parseFlags(picked, INSTALL_FLAGS);
  return picked;
}

const warn = (text) => process.stderr.write(`arch-lint: ${text}\n`);

// Returns what stops install from changing core.hooksPath, or null when it may.
function hooksPathBlocker(root, dir, opts, current) {
  if (opts.force) return null;
  if (current && !sameDir(current.resolved, dir)) {
    return `core.hooksPath is already set to ${current.value}, so installing into ${shown(root, dir) || "."} would take it over (use --force to replace it)`;
  }
  if (isOutside(root, dir) && isLinkedWorktree(root)) {
    return `this is a linked worktree and core.hooksPath is shared with every other worktree of the repository, so pointing it at ${dir} outside this one would change it for all of them (use --force to do it anyway)`;
  }
  return null;
}

function install(argv, { root }) {
  const opts = parseFlags(argv, INSTALL_FLAGS);
  const runner = runnerFor(root, opts);
  const dir = path.resolve(
    root,
    opts.dir ?? (opts.husky ? ".husky" : ".githooks")
  );
  const current = hooksPathSetting(root);

  if (!opts.husky) {
    const top = repoTopLevel(root);
    if (!top) throw new UsageError(`${root} is not inside a git repository`);
    if (!sameDir(top, root)) {
      throw new UsageError(
        `hooks install must run at the repository root (${top}), not in ${root}`
      );
    }
  }

  const contents = hookContents(root, runner);
  const blocker = opts.husky
    ? null
    : hooksPathBlocker(root, dir, opts, current);
  const conflicts = HOOK_NAMES.filter((name) => {
    const existing = read(path.join(dir, name));
    return existing !== null && existing !== contents[name] && !opts.force;
  });
  if (blocker || conflicts.length > 0) {
    if (blocker) warn(`${blocker}; nothing was changed`);
    for (const name of conflicts) {
      warn(
        `${shown(root, path.join(dir, name))} exists with different content and was not changed (use --force to overwrite)`
      );
    }
    return 1;
  }

  mkdirSync(dir, { recursive: true });
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    const existing = read(file);
    const verb =
      existing === null
        ? "wrote"
        : existing === contents[name]
          ? "unchanged"
          : "overwrote";
    if (verb !== "unchanged") writeFileSync(file, contents[name]);
    chmodSync(file, 0o755);
    process.stdout.write(`${verb} ${shown(root, file)}\n`);
  }

  if (opts.husky) {
    if (current && !readsDir(current.resolved, dir)) {
      warn(
        `core.hooksPath is set to ${current.value}, so git does not read ${shown(root, dir)} and these hooks will not run`
      );
    }
    process.stdout.write(
      "These hooks only run once husky is installed in this project (npm i -D husky, then run husky).\n"
    );
    return 0;
  }
  const rel = shown(root, dir);
  const value = isOutside(root, dir) ? dir : rel;
  const set = git(["config", "core.hooksPath", value], root);
  if (!set.ok) {
    throw new UsageError(`Cannot set core.hooksPath: ${set.stderr.trim()}`);
  }
  const replaced =
    current && !sameDir(current.resolved, dir) ? ` (was ${current.value})` : "";
  process.stdout.write(`core.hooksPath set to ${value}${replaced}\n`);
  return 0;
}

function status(argv, { root }) {
  const opts = parseFlags(argv, {
    booleans: ["--husky"],
    values: ["--dir", "--runner"],
  });
  const runner = runnerFor(root, opts);
  const found = repoTopLevel(root);
  const top = found && !sameDir(found, root) ? found : root;
  const configured = hooksPathSetting(root, top);
  const hooksPath = configured?.value ?? null;

  const dir = opts.dir
    ? path.resolve(root, opts.dir)
    : opts.husky
      ? path.resolve(top, ".husky")
      : (configured?.resolved ?? path.resolve(top, ".githooks"));
  const active = configured !== null && readsDir(configured.resolved, dir);

  process.stdout.write(`core.hooksPath: ${hooksPath ?? "not set"}\n`);
  process.stdout.write(`hooks directory: ${shown(root, dir) || "."}\n`);
  if (!active) {
    process.stdout.write(
      "git is not reading this directory, so these hooks do not run\n"
    );
  }

  const contents = hookContents(root, runner);
  let inPlace = active;
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    const existing = read(file);
    let state = "up to date";
    if (existing === null) state = "missing";
    else if (existing !== contents[name])
      state = "differs from what install would write";
    else if ((statSync(file).mode & 0o111) === 0) state = "not executable";
    if (state !== "up to date") inPlace = false;
    process.stdout.write(`${name}: ${state}\n`);
  }
  return inPlace ? 0 : 1;
}

export async function hooks(argv, ctx) {
  const [sub, ...rest] = argv;
  if (sub === "install") return install(rest, ctx);
  if (sub === "status") return status(rest, ctx);
  throw new UsageError("hooks needs a subcommand: install or status");
}
