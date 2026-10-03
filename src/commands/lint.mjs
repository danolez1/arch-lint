import path from "node:path";
import { loadBiomeCompat, reportBiomeNotes } from "../configs/biome-compat.mjs";
import {
  ESLINT_VALUE_FLAGS,
  PKG_ROOT,
  hasEslintConfig,
  hasFlag,
  positionals,
  resolveBin,
  run,
  wrapsBundledConfig,
} from "../util.mjs";
import { pullPythonFlags, runPython, withoutPythonFiles } from "./python.mjs";

async function eslint(argv, root) {
  const args = [resolveBin("eslint", "bin/eslint.js")];
  const bundled = !hasEslintConfig(root) && !hasFlag(argv, "-c", "--config");
  if (bundled) {
    args.push("--config", path.join(PKG_ROOT, "src/configs/eslint.config.mjs"));
  }
  if (bundled || wrapsBundledConfig(root, "eslint")) {
    const compat = loadBiomeCompat(root);
    if (compat) reportBiomeNotes(compat, ["linter", "files"]);
  }
  args.push(...argv);
  if (positionals(argv, ESLINT_VALUE_FLAGS).length === 0) args.push(".");
  return run(process.execPath, args, { cwd: root });
}

export async function lint(argv, { root }) {
  const { rest, js, python } = pullPythonFlags(argv);
  const eslintArgs = withoutPythonFiles(rest, ESLINT_VALUE_FLAGS, root);
  const runsEslint = js && !eslintArgs.skip;
  const jsCode = runsEslint ? await eslint(eslintArgs.argv, root) : 0;
  const pythonCode = python
    ? await runPython(hasFlag(rest, "--fix") ? "lint:fix" : "lint", {
        root,
        paths: positionals(rest, ESLINT_VALUE_FLAGS),
        machineOutput:
          runsEslint && hasFlag(rest, "-f", "--format", "-o", "--output-file"),
      })
    : 0;
  return jsCode || pythonCode;
}
