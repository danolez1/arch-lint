import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { UsageError } from "../util.mjs";

const SCRIPTS = {
  lint: "arch-lint lint",
  "lint:fix": "arch-lint lint --fix",
  format: "arch-lint format",
  "format:write": "arch-lint format:write",
  "arch-lint": "arch-lint arch",
  check: "arch-lint check",
  codeflow: "arch-lint codeflow analyze",
};

export async function init(argv, { root }) {
  const force = argv.includes("--force");
  const file = path.join(root, "package.json");
  if (!existsSync(file)) throw new UsageError(`No package.json in ${root}`);

  const raw = readFileSync(file, "utf8");
  const pkg = JSON.parse(raw);
  // Keep the file's own indentation so init does not rewrite lines it did not need to touch.
  const indent = raw.match(/^([ \t]+)"/m)?.[1] ?? 2;
  pkg.scripts ??= {};
  const added = [];
  const kept = [];
  for (const [name, command] of Object.entries(SCRIPTS)) {
    if (pkg.scripts[name] && !force) {
      kept.push(name);
      continue;
    }
    pkg.scripts[name] = command;
    added.push(name);
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, indent)}\n`);

  const config = path.join(root, "arch-lint.config.json");
  if (!existsSync(config)) {
    writeFileSync(config, '{\n  "extends": ["preset:recommended"]\n}\n');
  }

  process.stdout.write(`scripts added: ${added.join(", ") || "none"}\n`);
  if (kept.length > 0) {
    process.stdout.write(
      `scripts kept (use --force to overwrite): ${kept.join(", ")}\n`
    );
  }
  return 0;
}
