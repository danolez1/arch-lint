import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { UsageError, readProjectConfig, run } from "../util.mjs";

export const PYTHON_FLAGS = ["--no-python", "--python-only"];

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  ".tox",
  "dist",
  "build",
  ".next",
  ".turbo",
]);

const CONFIG_FILES = new Set([
  "ruff.toml",
  ".ruff.toml",
  "pyproject.toml",
  "mypy.ini",
  ".mypy.ini",
  "setup.cfg",
]);

const RUFF_TABLE = /^\s*\[tool\.ruff[\].]/m;
const MYPY_TABLE = /^\s*\[tool\.mypy[\].]/m;
const MYPY_SECTION = /^\s*\[mypy/m;
const UV_TABLE = /^\s*\[tool\.uv[\].]/m;

// mypy has no fix mode, so lint --fix leaves it out.
const PLAN = {
  lint: [
    ["ruff", ["check"]],
    ["mypy", []],
  ],
  "lint:fix": [["ruff", ["check", "--fix"]]],
  format: [["ruff", ["format", "--check"]]],
  "format:write": [["ruff", ["format"]]],
};

export function pullPythonFlags(argv) {
  const flags = argv.filter((arg) => PYTHON_FLAGS.includes(arg));
  if (new Set(flags).size > 1) {
    throw new UsageError("--no-python and --python-only cannot be combined");
  }
  return {
    rest: argv.filter((arg) => !PYTHON_FLAGS.includes(arg)),
    flags,
    js: !flags.includes("--python-only"),
    python: !flags.includes("--no-python"),
  };
}

function isExecutable(file) {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

function readText(file) {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

// An unreadable directory only means no Python project is found there.
function walk(dir, found) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), found);
    } else if (CONFIG_FILES.has(entry.name)) {
      found.push(path.join(dir, entry.name));
    }
  }
}

// Asking git also honors the project's .gitignore; null means it is not a repository.
function listWithGit(root) {
  const result = spawnSync(
    "git",
    [
      "ls-files",
      "-co",
      "--exclude-standard",
      "-z",
      "--",
      "*ruff.toml",
      "*pyproject.toml",
      "*mypy.ini",
      "*setup.cfg",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    }
  );
  if (result.error || result.status !== 0) return null;
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .map((rel) => path.join(root, rel))
    .filter(
      (file) =>
        CONFIG_FILES.has(path.basename(file)) &&
        !path
          .relative(root, file)
          .split(path.sep)
          .some((part) => SKIP_DIRS.has(part))
    );
}

function configFiles(root) {
  const listed = listWithGit(root);
  if (listed) return listed.filter(existsSync);
  const found = [];
  walk(root, found);
  return found;
}

function inspectDir(dir, names) {
  const pyproject = names.has("pyproject.toml")
    ? readText(path.join(dir, "pyproject.toml"))
    : "";
  const mypyConfigs = ["mypy.ini", ".mypy.ini", "setup.cfg"].filter((name) =>
    names.has(name)
  );
  return {
    ruff:
      names.has("ruff.toml") ||
      names.has(".ruff.toml") ||
      RUFF_TABLE.test(pyproject),
    mypy:
      MYPY_TABLE.test(pyproject) ||
      mypyConfigs.some((name) =>
        MYPY_SECTION.test(readText(path.join(dir, name)))
      ),
  };
}

const isInside = (dir, parent) => dir.startsWith(parent + path.sep);

// ruff reads the nearest config for each file itself, so a nested ruff root is already covered by its parent's run.
// mypy takes one config per run, so every mypy root runs on its own.
export function detectPythonProjects(root) {
  const byDir = new Map();
  for (const file of configFiles(root)) {
    const dir = path.dirname(file);
    if (!byDir.has(dir)) byDir.set(dir, new Set());
    byDir.get(dir).add(path.basename(file));
  }

  const ruffRoots = [];
  const projects = [];
  for (const dir of [...byDir.keys()].sort()) {
    const found = inspectDir(dir, byDir.get(dir));
    const ruff = found.ruff && !ruffRoots.some((p) => isInside(dir, p));
    if (ruff) ruffRoots.push(dir);
    if (ruff || found.mypy) projects.push({ dir, ruff, mypy: found.mypy });
  }
  return projects;
}

function usesUv(dir) {
  return (
    existsSync(path.join(dir, "uv.lock")) ||
    UV_TABLE.test(readText(path.join(dir, "pyproject.toml")))
  );
}

export function resolveTool(tool, dir) {
  const venv = path.join(dir, ".venv", "bin", tool);
  if (isExecutable(venv)) return { cmd: venv, args: [] };

  const uv = onPath("uv");
  // A project that locks its dependencies with uv needs mypy inside that environment to see them.
  if (tool === "mypy" && uv && usesUv(dir)) {
    return { cmd: uv, args: ["run", "--directory", dir, "mypy"] };
  }
  const found = onPath(tool);
  if (found) return { cmd: found, args: [] };
  if (tool === "ruff" && uv) return { cmd: uv, args: ["tool", "run", "ruff"] };
  return null;
}

const pythonRequired = (root) =>
  readProjectConfig(root).python?.required !== false;

const PYTHON_FILE = /\.pyi?$/;

function isDirectory(root, given) {
  try {
    return statSync(path.resolve(root, given)).isDirectory();
  } catch {
    return false;
  }
}

const isPythonFile = (given, root) =>
  PYTHON_FILE.test(given) && !isDirectory(root, given);

// Any other file belongs to the JavaScript tools, and ruff reports a syntax error for it.
const forRuff = (given, root) =>
  isPythonFile(given, root) || isDirectory(root, given);

// ESLint warns and Prettier exits 2 on a Python file, so neither is given one.
export function withoutPythonFiles(argv, valueFlags, root) {
  const kept = [];
  let named = 0;
  let left = 0;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      kept.push(...argv.slice(i, i + 2));
      i++;
    } else if (arg.startsWith("-")) {
      kept.push(arg);
    } else {
      named++;
      if (isPythonFile(arg, root)) continue;
      left++;
      kept.push(arg);
    }
  }
  return { argv: kept, skip: named > 0 && left === 0 };
}

function targetsFor(dir, root, paths) {
  if (paths.length === 0) return ["."];
  const targets = new Set();
  for (const given of paths) {
    const abs = path.resolve(root, given);
    const within = path.relative(dir, abs);
    if (!within.startsWith("..") && !path.isAbsolute(within)) {
      targets.add(within || ".");
    } else if (isInside(dir, abs)) {
      targets.add(".");
    }
  }
  return targets.size > 0 ? [...targets] : null;
}

const detected = new Map();

// mypy ignores the paths and checks its whole root, since a partial run misses what the other files declare.
export async function runPython(
  action,
  { root, paths = [], machineOutput = false }
) {
  const named = paths.filter((given) => forRuff(given, root));
  if (paths.length > 0 && named.length === 0) return 0;

  if (!detected.has(root)) detected.set(root, detectPythonProjects(root));
  const jobs = [];
  for (const project of detected.get(root)) {
    const targets = targetsFor(project.dir, root, named);
    if (!targets) continue;
    for (const [tool, leading] of PLAN[action]) {
      if (project[tool]) jobs.push({ project, tool, leading, targets });
    }
  }
  if (jobs.length === 0) return 0;
  if (machineOutput) {
    process.stderr.write(
      "arch-lint: python: skipped because ESLint output flags are set and ruff and mypy would write to the same stdout.\n"
    );
    return 0;
  }

  let required;
  let exitCode = 0;
  for (const { project, tool, leading, targets } of jobs) {
    const resolved = resolveTool(tool, project.dir);
    if (!resolved) {
      required ??= pythonRequired(root);
      const shown = path.relative(root, project.dir) || "the project root";
      process.stderr.write(
        required
          ? `arch-lint: python: ${tool} not found for ${shown}. Install ${tool} or uv, or set "python": { "required": false } in arch-lint.config.json to skip.\n`
          : `arch-lint: python: ${tool} not found for ${shown}, skipped. Install ${tool} or uv.\n`
      );
      if (required) exitCode ||= 1;
      continue;
    }
    const code = await run(
      resolved.cmd,
      [...resolved.args, ...leading, ...(tool === "ruff" ? targets : ["."])],
      { cwd: project.dir }
    );
    exitCode ||= code;
  }
  return exitCode;
}
