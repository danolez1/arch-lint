// Re-lifts the analyzer core from a checkout of the upstream CodeFlow project into src/codeflow/core.js.
// Usage: node scripts/sync-codeflow.mjs --from <path to the upstream checkout> [--check] [--no-test]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src/codeflow/core.js");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const fromIndex = args.indexOf("--from");
const from = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
if (!from) {
  process.stderr.write(
    "Usage: node scripts/sync-codeflow.mjs --from <upstream checkout> [--check] [--no-test]\n"
  );
  process.exit(2);
}

const upstream = path.resolve(from);
const indexHtml = path.join(upstream, "index.html");
if (!existsSync(indexHtml)) {
  process.stderr.write(
    `No index.html in ${upstream}, is that a CodeFlow checkout?\n`
  );
  process.exit(2);
}

const BLOCKS = [
  [
    "// ===== CODEFLOW_ANALYZER_START =====",
    "// ===== CODEFLOW_ANALYZER_END =====",
  ],
  [
    "// ===== CODEFLOW_METRICS_START =====",
    "// ===== CODEFLOW_METRICS_END =====",
  ],
];
const html = readFileSync(indexHtml, "utf8");
const lifted = BLOCKS.map(([start, end]) => {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  if (from < 0 || to < 0)
    throw new Error(`Upstream no longer has the ${start} block`);
  return html.slice(from, to + end.length);
});

// The browser worker plumbing needs document, window and fetch, and nothing headless calls it.
const WORKER_HEADING = "// Inline Worker Runtime";
lifted[0] = removeWorkerRuntime(lifted[0]);

function removeWorkerRuntime(block) {
  const heading = block.indexOf(WORKER_HEADING);
  if (heading < 0) return block;
  const ruler = block.lastIndexOf("\n// ----", heading) + 1;
  const end = block.lastIndexOf("// ===== CODEFLOW_ANALYZER_END =====");
  return `${block.slice(0, ruler).replace(/\n+$/, "\n")}${block.slice(end)}`;
}

const git = (...gitArgs) =>
  spawnSync("git", ["-C", upstream, ...gitArgs], { encoding: "utf8" });
const sha = git("rev-parse", "--short", "HEAD");
const stamp = git("log", "-1", "--format=%cs");
const dirty = git("status", "--porcelain").stdout?.trim();
if (dirty)
  process.stderr.write(
    "warning: the upstream checkout has uncommitted changes, which are being lifted too\n"
  );
const version =
  sha.status === 0
    ? `${sha.stdout.trim()}, ${stamp.stdout.trim()}`
    : "unknown commit";

const header = `// Lifted from upstream CodeFlow (${version}) by scripts/sync-codeflow.mjs. Change upstream and sync, do not edit by hand.\n`;
const next = `${header}${lifted.join("\n")}\n`;
const current = existsSync(target) ? readFileSync(target, "utf8") : "";
const body = (text) => text.replace(/^\/\/ Lifted from upstream[^\n]*\n/, "");

const licenseUpstream = path.join(upstream, "LICENSE");
const licenseHere = path.join(root, "src/codeflow/LICENSE");
if (
  existsSync(licenseUpstream) &&
  readFileSync(licenseUpstream, "utf8") !== readFileSync(licenseHere, "utf8")
) {
  process.stderr.write(
    "warning: the upstream LICENSE differs from src/codeflow/LICENSE, review it before publishing\n"
  );
}

const same = body(next) === body(current);
if (flag("--check")) {
  process.stdout.write(
    same
      ? `core.js body matches upstream ${version}\n`
      : `core.js differs from upstream ${version}\n`
  );
  process.exit(same ? 0 : 1);
}
if (next === current) {
  process.stdout.write(
    `core.js is already up to date with upstream ${version}\n`
  );
  process.exit(0);
}

writeFileSync(target, next);
process.stdout.write(`wrote src/codeflow/core.js from upstream ${version}\n`);

if (!flag("--no-test")) {
  // npm expands the test globs itself, which node --test only does from Node 21.
  const tests = spawnSync("npm", ["run", "test:codeflow"], {
    cwd: root,
    stdio: "inherit",
  });
  if (tests.status !== 0) {
    process.stderr.write(
      "\nThe CodeFlow tests fail with the new core. Review the upstream changes before committing.\n"
    );
    process.exit(1);
  }
}
