import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

const require = createRequire(import.meta.url);

export class UsageError extends Error {}

export function resolveBin(pkg, relBin) {
  const pkgJson = require.resolve(`${pkg}/package.json`);
  return path.join(path.dirname(pkgJson), relBin);
}

export function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("error", (err) => {
      process.stderr.write(`arch-lint: cannot start ${cmd}: ${err.message}\n`);
      resolve(127);
    });
    child.on("close", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
}

const ESLINT_CONFIGS = ["js", "mjs", "cjs", "ts", "mts", "cts"].map(
  (ext) => `eslint.config.${ext}`
);

const PRETTIER_CONFIGS = [
  ".prettierrc",
  ...[
    "json",
    "yml",
    "yaml",
    "json5",
    "js",
    "cjs",
    "mjs",
    "ts",
    "mts",
    "cts",
    "toml",
  ].flatMap((ext) => [`.prettierrc.${ext}`, `prettier.config.${ext}`]),
];

export function readProjectConfig(root) {
  const file = path.join(root, "arch-lint.config.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    throw new UsageError(`Cannot read ${file}: ${err.message}`);
  }
}

export function detectLockfiles(root) {
  const has = (...names) =>
    names.some((name) => existsSync(path.join(root, name)));
  return {
    npm: has("package-lock.json"),
    pnpm: has("pnpm-lock.yaml"),
    bun: has("bun.lock", "bun.lockb"),
  };
}

export function readProjectPackage(root) {
  const file = path.join(root, "package.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
}

// ESLint 9 and Prettier both look in parent directories, so a monorepo root config applies to its packages.
function upwardsFrom(root, test) {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (test(dir)) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

export function hasEslintConfig(root) {
  return upwardsFrom(root, (dir) =>
    ESLINT_CONFIGS.some((name) => existsSync(path.join(dir, name)))
  );
}

export function hasPrettierConfig(root) {
  return upwardsFrom(
    root,
    (dir) =>
      PRETTIER_CONFIGS.some((name) => existsSync(path.join(dir, name))) ||
      Boolean(readProjectPackage(dir)?.prettier)
  );
}

const OPTED_OUT = /\bbiome\s*:\s*false\b/;

// A config that imports the bundled factory gets biome.json mapped inside createConfig, so the CLI reports and applies the rest like it does for the bundled config.
export function wrapsBundledConfig(root, tool) {
  const specifier = `arch-lint/${tool}`;
  const mentions = (text) => text.includes(specifier) && !OPTED_OUT.test(text);
  const names = tool === "eslint" ? ESLINT_CONFIGS : PRETTIER_CONFIGS;
  return upwardsFrom(
    root,
    (dir) =>
      names.some((name) => {
        const file = path.join(dir, name);
        return existsSync(file) && mentions(readFileSync(file, "utf8"));
      }) ||
      (tool === "prettier" &&
        mentions(JSON.stringify(readProjectPackage(dir)?.prettier ?? "")))
  );
}

// Flags that consume the next token, so their values are not mistaken for paths.
export const ESLINT_VALUE_FLAGS = new Set([
  "-c",
  "--config",
  "--max-warnings",
  "-f",
  "--format",
  "--ext",
  "--rule",
  "--ignore-pattern",
  "-o",
  "--output-file",
  "--cache-location",
  "--parser",
  "--parser-options",
  "--plugin",
  "--resolve-plugins-relative-to",
  "--env",
  "--global",
  "--report-unused-disable-directives-severity",
  "--stdin-filename",
  "--flag",
  "--concurrency",
]);

export const PRETTIER_VALUE_FLAGS = new Set([
  "--config",
  "--ignore-path",
  "--plugin",
  "--parser",
  "--print-width",
  "--tab-width",
  "--trailing-comma",
  "--end-of-line",
  "--arrow-parens",
  "--quote-props",
  "--prose-wrap",
  "--html-whitespace-sensitivity",
  "--embedded-language-formatting",
  "--object-wrap",
  "--experimental-operator-position",
  "--log-level",
  "--cache-location",
  "--cache-strategy",
  "--stdin-filepath",
  "--config-precedence",
  "--range-start",
  "--range-end",
  "--find-config-path",
  "--file-info",
  "--cursor-offset",
]);

export function positionals(argv, valueFlags) {
  const found = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valueFlags.has(arg)) {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) found.push(arg);
  }
  return found;
}

export function hasFlag(argv, ...names) {
  return argv.some((arg) => names.includes(arg.split("=")[0]));
}
