import { arch } from "./arch.mjs";
import { format } from "./format.mjs";
import { lint } from "./lint.mjs";

export async function check(argv, ctx) {
  const skipArch = argv.includes("--skip-arch");
  // A project with no JS or TS files would otherwise fail ESLint for matching nothing.
  const steps = [
    ["lint", () => lint(["--no-error-on-unmatched-pattern"], ctx)],
    ["format", () => format([], { ...ctx, write: false })],
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
