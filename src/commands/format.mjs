import { existsSync } from "node:fs";
import path from "node:path";
import {
  loadBiomeCompat,
  reportBiomeNotes,
  withPrettierIgnoreFile,
} from "../configs/biome-compat.mjs";
import {
  PKG_ROOT,
  PRETTIER_VALUE_FLAGS,
  hasFlag,
  hasPrettierConfig,
  positionals,
  resolveBin,
  run,
  wrapsBundledConfig,
} from "../util.mjs";
import { pullPythonFlags, runPython, withoutPythonFiles } from "./python.mjs";

async function prettier(argv, root, write) {
  const args = [resolveBin("prettier", "bin/prettier.cjs")];
  let biomeIgnore = [];
  const bundled = !hasPrettierConfig(root) && !hasFlag(argv, "--config");
  if (bundled) {
    args.push(
      "--config",
      path.join(PKG_ROOT, "src/configs/prettier.config.mjs")
    );
  }
  if (bundled || wrapsBundledConfig(root, "prettier")) {
    const compat = loadBiomeCompat(root);
    if (compat) {
      reportBiomeNotes(compat, ["formatter", "files"]);
      biomeIgnore = compat.prettierIgnore;
    }
  }
  // Passing --ignore-path replaces Prettier's defaults, so the project's own ignore files are named again.
  for (const name of [".gitignore", ".prettierignore"]) {
    if (existsSync(path.join(root, name))) args.push("--ignore-path", name);
  }
  args.push("--ignore-path", path.join(PKG_ROOT, "src/configs/prettierignore"));
  args.push(write ? "--write" : "--check", ...argv);
  if (positionals(argv, PRETTIER_VALUE_FLAGS).length === 0) args.push(".");
  return withPrettierIgnoreFile(root, biomeIgnore, (ignoreFile) => {
    if (ignoreFile) args.push("--ignore-path", ignoreFile);
    return run(process.execPath, args, { cwd: root });
  });
}

export async function format(argv, { root, write }) {
  const { rest, js, python } = pullPythonFlags(argv);
  const prettierArgs = withoutPythonFiles(rest, PRETTIER_VALUE_FLAGS, root);
  const jsCode =
    js && !prettierArgs.skip
      ? await prettier(prettierArgs.argv, root, write)
      : 0;
  const pythonCode = python
    ? await runPython(write ? "format:write" : "format", {
        root,
        paths: positionals(rest, PRETTIER_VALUE_FLAGS),
      })
    : 0;
  return jsCode || pythonCode;
}
