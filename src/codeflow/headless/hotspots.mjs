// Headless CodeFlow reports churn as zero, so hotspots are rebuilt from git history.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const MAX_BUFFER = 512 * 1024 * 1024;
const DEFAULT_SINCE = "180 days ago";

export function git(root, args, input) {
  return execFileSync(
    "git",
    ["-C", root, "-c", "core.quotepath=off", ...args],
    {
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
      input,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
}

export function isGitRepo(root) {
  try {
    return git(root, ["rev-parse", "--is-inside-work-tree"]).trim() === "true";
  } catch {
    return false;
  }
}

export function gitHead(root) {
  try {
    return git(root, ["rev-parse", "--short", "HEAD"]).trim();
  } catch {
    return null;
  }
}

// NUL framing keeps paths with spaces or quotes intact; exit 1 only means nothing matched.
export function gitIgnoredPaths(root, paths) {
  if (!paths.length) return new Set();
  let out;
  try {
    out = git(root, ["check-ignore", "-z", "--stdin"], `${paths.join("\0")}\0`);
  } catch (err) {
    if (err.status !== 1) throw err;
    out = err.stdout || "";
  }
  return new Set(out.split("\0").filter(Boolean));
}

// \x01 cannot appear in a path, unlike "@" which would clash with a file named that way.
function readChurn(root, since) {
  const churn = new Map();
  const authors = new Map();
  if (!gitHead(root)) return { churn, authors };
  const log = git(root, [
    "log",
    `--since=${since}`,
    "--no-merges",
    "--relative",
    "--format=%x01%ae",
    "--name-only",
  ]);
  let current = null;
  for (const line of log.split("\n")) {
    if (line.startsWith("\x01")) {
      current = line.slice(1);
      continue;
    }
    if (!line) continue;
    churn.set(line, (churn.get(line) || 0) + 1);
    if (!authors.has(line)) authors.set(line, new Set());
    authors.get(line).add(current);
  }
  return { churn, authors };
}

export function buildHotspots(data, root, since = DEFAULT_SINCE) {
  const repo = resolve(root);
  // .gitignore may have changed since the scan, so ignore state is re-read now.
  const ignored = gitIgnoredPaths(
    repo,
    data.files.map((f) => f.path)
  );
  const { churn, authors } = readChurn(repo, since);

  const rows = data.files
    .filter(
      (f) =>
        f.isCode !== false &&
        !ignored.has(f.path) &&
        existsSync(join(repo, f.path))
    )
    .map((f) => {
      const c = churn.get(f.path) || 0;
      const complexity = f.complexity ? f.complexity.score : 0;
      return {
        path: f.path,
        churn: c,
        complexity,
        lines: f.lines,
        authors: authors.has(f.path) ? authors.get(f.path).size : 0,
        hotspot: c * complexity,
      };
    })
    .filter((r) => r.hotspot > 0)
    .sort((a, b) => b.hotspot - a.hotspot || a.path.localeCompare(b.path));

  return { head: gitHead(repo), since, ignoredNow: ignored.size, rows };
}
