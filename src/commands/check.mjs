import { arch } from "./arch.mjs";
import { format } from "./format.mjs";
import { lint } from "./lint.mjs";
import { pullPythonFlags } from "./python.mjs";

export async function check(argv, ctx) {
  const { flags, js } = pullPythonFlags(argv);
  // The architecture rules only read JS and TS, so a Python-only run has nothing for them.
  const skipArch = argv.includes("--skip-arch") || !js;
  // A project with no JS or TS files would otherwise fail ESLint for matching nothing.
  const steps = [
    ["lint", () => lint([...flags, "--no-error-on-unmatched-pattern"], ctx)],
    ["format", () => format(flags, { ...ctx, write: false })],
  ];
  if (!skipArch) {
    steps.push(["arch", () => arch([], ctx)]);
  }

  const failed = [];
  for (const [name, step] of steps) {
    process.stdout.write(`\n== arch-lint ${name}\n`);
    if ((await step()) !== 0) failed.push(name);
  }

  if (failed.length > 0) {
    process.stderr.write(`\narch-lint check failed: ${failed.join(", ")}\n`);
    return 1;
  }
  process.stdout.write("\narch-lint check passed\n");
  return 0;
}
