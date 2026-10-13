import { spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const archEntry = path.join(packageRoot, "src", "arch", "index.ts");
const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
const results = new Map();
const watchers = new Map();
const maxWatchedProjects = 16;

function clearResults(root) {
  for (const key of results.keys())
    if (key.startsWith(`${root}:`)) results.delete(key);
}

function projectRoot(context) {
  return path.resolve(
    context.settings?.archLint?.root ?? context.cwd ?? process.cwd()
  );
}

function watchProject(root) {
  if (watchers.has(root)) return watchers.get(root);
  if (watchers.size >= maxWatchedProjects) {
    const [oldestRoot, watcher] = watchers.entries().next().value;
    watcher?.close?.();
    watchers.delete(oldestRoot);
    clearResults(oldestRoot);
  }
  try {
    const watcher = watch(root, { recursive: true }, () => {
      if (!existsSync(root)) {
        watcher.close();
        if (watchers.get(root) === watcher) watchers.delete(root);
        clearResults(root);
        return;
      }
      clearResults(root);
    });
    watcher.on("error", () => {
      watcher.close();
      if (watchers.get(root) === watcher) watchers.set(root, false);
      clearResults(root);
    });
    watcher.unref();
    watchers.set(root, watcher);
  } catch {
    watchers.set(root, false);
  }
  return watchers.get(root);
}

function findingsFor(root, graphOnly) {
  const cacheKey = `${root}:${graphOnly}`;
  const watching = watchProject(root);
  const cached = results.get(cacheKey);
  if (cached && (watching || cached.expires > Date.now())) return cached.result;
  if (cached) results.delete(cacheKey);
  const args = [
    "--import",
    tsxLoader,
    archEntry,
    "--root",
    root,
    "--format",
    "json",
  ];
  if (graphOnly) args.push("--graph", "--rule", "architecture-graph");
  const child = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(child.stdout);
  } catch {
    parsed = {
      error:
        child.stderr ||
        child.stdout ||
        `arch-lint exited with code ${child.status}`,
    };
  }
  results.set(cacheKey, { result: parsed, expires: Date.now() + 1000 });
  return parsed;
}

function normalizeFile(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function makeRule(graphOnly) {
  return {
    meta: {
      type: "problem",
      docs: {
        description: graphOnly
          ? "Check AST dependency graph architecture rules"
          : "Run arch-lint architecture rules",
      },
      schema: [],
      messages: { finding: "{{message}}", failed: "{{message}}" },
    },
    create(context) {
      const root = projectRoot(context);
      const currentFile = normalizeFile(root, context.getFilename());
      let reported = false;
      return {
        Program() {
          if (reported) return;
          reported = true;
          const result = findingsFor(root, graphOnly);
          if (result.error) {
            context.report({
              loc: { line: 1, column: 0 },
              messageId: "failed",
              data: { message: `arch-lint scan failed: ${result.error}` },
            });
            return;
          }
          for (const finding of result.findings ?? []) {
            if (finding.file !== currentFile) continue;
            context.report({
              loc: { line: Math.max(1, finding.line ?? 1), column: 0 },
              messageId: "finding",
              data: { message: `[${finding.rule}] ${finding.message}` },
            });
          }
        },
      };
    },
  };
}

const plugin = {
  meta: { name: "@danolez/arch-lint", version: "0.1.0" },
  rules: {
    architecture: makeRule(false),
    "architecture-graph": makeRule(true),
  },
};

plugin.configs = {
  recommended: {
    plugins: { archlint: plugin },
    rules: { "archlint/architecture": "error" },
  },
  graph: {
    plugins: { archlint: plugin },
    rules: { "archlint/architecture-graph": "error" },
  },
};

export default plugin;
