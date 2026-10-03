import path from "node:path";
import {
  ESLINT_VALUE_FLAGS,
  PKG_ROOT,
  hasEslintConfig,
  hasFlag,
  positionals,
  resolveBin,
  run,
} from "../util.mjs";

export async function lint(argv, { root }) {
  const args = [resolveBin("eslint", "bin/eslint.js")];
  if (!hasEslintConfig(root) && !hasFlag(argv, "-c", "--config")) {
    args.push("--config", path.join(PKG_ROOT, "src/configs/eslint.config.mjs"));
  }
  args.push(...argv);
  if (positionals(argv, ESLINT_VALUE_FLAGS).length === 0) args.push(".");
  return run(process.execPath, args, { cwd: root });
}
