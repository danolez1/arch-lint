import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { UsageError } from "./util.mjs";

export function git(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? ""),
  };
}

export function repoTopLevel(root) {
  const result = git(["rev-parse", "--show-toplevel"], root);
  return result.ok ? result.stdout.trim() : null;
}

function listPaths(root, args, what) {
  const result = git(
    ["diff", ...args, "--name-only", "--relative", "-z"],
    root
  );
  if (!result.ok) {
    throw new UsageError(
      `Cannot list ${what} files in ${root}: ${result.stderr.trim()}`
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

// --relative keeps the paths valid from a project that sits inside a larger repository.
export function stagedFiles(root) {
  return listPaths(root, ["--cached", "--diff-filter=ACMR"], "staged");
}

// Files whose working tree copy differs from the index.
export function unstagedFiles(root) {
  return listPaths(root, [], "modified");
}

// Relative values resolve against the top level, which is where git runs the hooks.
export function hooksPathSetting(root, top = repoTopLevel(root) ?? root) {
  const raw = git(["config", "--get", "core.hooksPath"], root);
  if (!raw.ok) return null;
  const value = raw.stdout.trim();
  const expanded = git(
    ["config", "--type=path", "--get", "core.hooksPath"],
    root
  );
  return {
    value,
    resolved: path.resolve(top, expanded.ok ? expanded.stdout.trim() : value),
  };
}

// A linked worktree has its own git dir but shares the common one, where core.hooksPath lives.
export function isLinkedWorktree(root) {
  const result = git(["rev-parse", "--git-dir", "--git-common-dir"], root);
  if (!result.ok) return false;
  const [gitDir, common] = result.stdout
    .split("\n")
    .map((line) => path.resolve(root, line.trim()));
  return canonicalPath(gitDir) !== canonicalPath(common);
}

// Resolves symlinks in the part that exists, so a directory that is not created yet still compares correctly.
export function canonicalPath(file) {
  const tail = [];
  let current = path.resolve(file);
  for (;;) {
    try {
      return path.join(realpathSync(current), ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(file);
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

const SAFE_REF = /^[\w./@-]+$/;

// Null when baseRef has no remote part, because there is then nothing to fetch.
export function baseFetch({
  baseRef = "origin/main",
  releaseRef = "refs/heads/main",
} = {}) {
  for (const ref of [baseRef, releaseRef]) {
    if (typeof ref !== "string" || !SAFE_REF.test(ref)) {
      throw new UsageError(
        `migrations ref ${JSON.stringify(ref)} may only contain letters, digits and . _ / @ -`
      );
    }
  }
  const tracking = baseRef.replace(/^refs\/remotes\//, "");
  const [remote, ...branch] = tracking.split("/");
  if (branch.length === 0) return null;
  const source = releaseRef.startsWith("refs/")
    ? releaseRef
    : `refs/heads/${releaseRef}`;
  return {
    remote,
    refspec: `+${source}:refs/remotes/${tracking}`,
    baseRef: tracking,
  };
}

export function migrationsConfigured(config) {
  return (
    config.migrations?.dir !== undefined ||
    config.migrations?.journal !== undefined
  );
}
