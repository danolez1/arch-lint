import { createConfig } from "./src/configs/eslint.config.mjs";

// The CodeFlow core and its tests are upstream code kept as shipped, so they are not linted.
// reference/ is a local-only folder that can exist on a machine but is not part of the repo.
export default await createConfig({
  ignores: [
    "src/codeflow/core.js",
    "src/codeflow/analyze.js",
    "src/codeflow/lib/**",
    "tests/codeflow/**",
    "tests/perf/**",
    "reference/**",
  ],
});
