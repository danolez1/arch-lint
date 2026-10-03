import { existsSync } from "node:fs";
import path from "node:path";
import {
  PKG_ROOT,
  PRETTIER_VALUE_FLAGS,
  hasFlag,
  hasPrettierConfig,
  positionals,
  resolveBin,
  run,
} from "../util.mjs";

export async function format(argv, { root, write }) {
  const args = [resolveBin("prettier", "bin/prettier.cjs")];
  if (!hasPrettierConfig(root) && !hasFlag(argv, "--config")) {
    args.push(
      "--config",
      path.join(PKG_ROOT, "src/configs/prettier.config.mjs")
    );
  }
  // Passing --ignore-path replaces Prettier's defaults, so the project's own ignore files are named again.
  for (const name of [".gitignore", ".prettierignore"]) {
    if (existsSync(path.join(root, name))) args.push("--ignore-path", name);
  }
  args.push("--ignore-path", path.join(PKG_ROOT, "src/configs/prettierignore"));
  args.push(write ? "--write" : "--check", ...argv);
  if (positionals(argv, PRETTIER_VALUE_FLAGS).length === 0) args.push(".");
  return run(process.execPath, args, { cwd: root });
}
