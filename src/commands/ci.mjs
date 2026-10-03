import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { baseFetch, migrationsConfigured } from "../git.mjs";
import { detectLockfiles, readProjectConfig } from "../util.mjs";

const WORKFLOW = ".github/workflows/arch-lint.yml";

function installSteps(root) {
  const lock = detectLockfiles(root);
  if (lock.npm) return ["- name: Install", "  run: npm ci"];
  if (lock.pnpm) {
    return [
      "- name: Enable pnpm",
      "  run: corepack enable",
      "- name: Install",
      "  run: pnpm install --frozen-lockfile",
    ];
  }
  if (lock.bun) {
    return [
      "- uses: oven-sh/setup-bun@v2",
      "- name: Install",
      "  run: bun install --frozen-lockfile",
    ];
  }
  return ["- name: Install", "  run: npm install"];
}

function fetchStep(config) {
  if (!migrationsConfigured(config)) return [];
  const fetch = baseFetch(config.migrations);
  if (!fetch) return [];
  return [
    // A pull request checkout does not carry the base ref the migration rules diff against.
    "- name: Fetch the migration base",
    `  run: git fetch --no-tags --depth=1 ${fetch.remote} ${fetch.refspec}`,
  ];
}

export function workflowText(root) {
  const steps = [
    "- uses: actions/checkout@v4",
    "- uses: actions/setup-node@v4",
    "  with:",
    "    node-version: 20",
    ...installSteps(root),
    ...fetchStep(readProjectConfig(root)),
    "- name: Check",
    "  run: npx arch-lint check",
  ];
  return [
    "name: arch-lint",
    "",
    "on:",
    "  push:",
    "    branches: [main]",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...steps.map((line) => `      ${line}`),
    "",
  ].join("\n");
}

export function writeWorkflow({ root, force }) {
  const file = path.join(root, WORKFLOW);
  const text = workflowText(root);
  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (existing === text) {
    process.stdout.write(`unchanged ${WORKFLOW}\n`);
    return 0;
  }
  if (existing !== null && !force) {
    process.stderr.write(
      `arch-lint: ${WORKFLOW} exists with different content and was not changed (use --force to overwrite)\n`
    );
    return 1;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  process.stdout.write(
    `${existing === null ? "wrote" : "overwrote"} ${WORKFLOW}\n`
  );
  return 0;
}
