import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { matchesAny } from "./paths";
import { buildSource } from "./source";
import type { ResolvedConfig, SourceFile } from "./types";

// A seam so tests can run rules against an in-memory map instead of the disk.
export interface FileSystem {
  /** Every non-ignored project-relative path under the scan roots. */
  list(): string[];
  read(path: string): string | null;
}

const toPosix = (p: string) => p.split(path.sep).join("/");

function staticPrefix(pattern: string): string {
  const parts = pattern.split("/");
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?{]/.test(part)) break;
    fixed.push(part);
  }
  return fixed.join("/");
}

function walk(
  root: string,
  rel: string,
  config: ResolvedConfig,
  out: string[]
): void {
  let entries: string[];
  try {
    entries = readdirSync(path.join(root, rel));
  } catch {
    return;
  }
  for (const name of entries) {
    const child = rel ? `${rel}/${name}` : name;
    let isDir: boolean;
    try {
      isDir = statSync(path.join(root, child)).isDirectory();
    } catch {
      continue; // dangling symlink or a file removed mid-walk
    }
    if (matchesAny(isDir ? `${child}/` : child, config.ignore)) continue;
    if (isDir) walk(root, child, config, out);
    else out.push(child);
  }
}

export function diskFileSystem(
  root: string,
  config: ResolvedConfig
): FileSystem {
  let cached: string[] | null = null;
  return {
    list() {
      if (cached) return cached;
      const found = new Set<string>();
      for (const entry of config.scan) {
        const base = toPosix(path.normalize(staticPrefix(entry) || "."));
        const prefix = base === "." ? "" : base;
        const full = path.join(root, prefix);
        if (!existsSync(full)) continue;
        const paths: string[] = [];
        if (statSync(full).isDirectory()) walk(root, prefix, config, paths);
        else paths.push(prefix);
        const isGlob = /[*?{]/.test(entry);
        for (const p of paths) {
          if (!isGlob || matchesAny(p, [entry, `${entry}/**`])) found.add(p);
        }
      }
      cached = [...found].sort();
      return cached;
    },
    read(p) {
      try {
        return readFileSync(path.join(root, p), "utf8");
      } catch {
        return null;
      }
    },
  };
}

export function memoryFileSystem(files: Record<string, string>): FileSystem {
  return {
    list: () => Object.keys(files).sort(),
    read: (p) => files[p] ?? null,
  };
}

const SOURCE = /\.(ts|tsx)$/;

export function isSourceFile(p: string, config: ResolvedConfig): boolean {
  return SOURCE.test(p) && !p.endsWith(".d.ts") && !matchesAny(p, config.tests);
}

export function collectSources(
  fs: FileSystem,
  config: ResolvedConfig
): SourceFile[] {
  return fs
    .list()
    .filter((p) => isSourceFile(p, config))
    .map((p) => buildSource(p, fs.read(p) ?? ""));
}
