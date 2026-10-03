// CodeFlow does not resolve tsconfig path aliases, so on the raw tree it sees almost no imports.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { buildHotspots, git, isGitRepo } from "./hotspots.mjs";
import { renderReport } from "./report.mjs";

const require = createRequire(import.meta.url);

const REWRITE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const PROBE_EXT = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
];
const WALK_SKIP = new Set([".git", "node_modules"]);
// Mock helpers are included because a mocked alias path fails to resolve the same way an import does.
const SPECIFIER =
  /(\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|\b(?:mock|doMock|importActual|requireActual)\(\s*)(["'])([^"'\n]+)\2/g;

// tsconfig files allow comments and trailing commas, which JSON.parse rejects.
export function parseJsonc(text) {
  const src = text.replace(/^\uFEFF/, "");
  let noComments = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      noComments += ch;
      if (ch === "\\") noComments += src[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      noComments += ch;
    } else if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      noComments += "\n";
    } else if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 1;
    } else {
      noComments += ch;
    }
  }
  let out = "";
  inString = false;
  for (let i = 0; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inString) {
      out += ch;
      if (ch === "\\") out += noComments[++i] ?? "";
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === ",") {
      let j = i + 1;
      while (/\s/.test(noComments[j] ?? "")) j++;
      if (noComments[j] !== "}" && noComments[j] !== "]") out += ch;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

// Follows relative "extends" chains; package-based extends cannot be resolved without node_modules.
function readCompilerOptions(file, depth = 0) {
  const parsed = parseJsonc(readFileSync(file, "utf8"));
  let merged = { baseUrl: null, paths: null, pathsDir: null };
  if (depth < 8) {
    const parents = [].concat(parsed.extends ?? []);
    for (const ext of parents) {
      if (typeof ext !== "string" || !ext.startsWith(".")) continue;
      let parent = resolve(dirname(file), ext);
      if (!existsSync(parent) && existsSync(`${parent}.json`))
        parent += ".json";
      if (existsSync(parent)) merged = readCompilerOptions(parent, depth + 1);
    }
  }
  const co = parsed.compilerOptions ?? {};
  if (co.baseUrl !== undefined) {
    merged.baseUrl = resolve(dirname(file), co.baseUrl);
  }
  if (co.paths) {
    merged.paths = co.paths;
    merged.pathsDir = dirname(file);
  }
  return merged;
}

const toRel = (root, abs) => relative(root, abs).split(sep).join("/");

// "@/": "src/" style shorthand is accepted next to the full tsconfig "@/*": ["src/*"] form.
function normalizeOverride(aliases) {
  const out = {};
  for (const [key, value] of Object.entries(aliases)) {
    const targets = [].concat(value);
    if (key.endsWith("/") && !key.includes("*")) {
      out[`${key}*`] = targets.map((t) => `${t.replace(/\/?$/, "/")}*`);
    } else {
      out[key] = targets;
    }
  }
  return out;
}

export function loadAliasConfig(root, aliases) {
  const rootAbs = resolve(root);
  const warnings = [];
  let options = { baseUrl: null, paths: null, pathsDir: null };
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const file = join(rootAbs, name);
    if (!existsSync(file)) continue;
    try {
      options = readCompilerOptions(file);
    } catch (err) {
      warnings.push(`${name} could not be parsed: ${err.message}`);
    }
    break;
  }

  const baseUrl = options.baseUrl ? toRel(rootAbs, options.baseUrl) : null;
  const source = aliases ? normalizeOverride(aliases) : (options.paths ?? {});
  const baseDir = aliases
    ? rootAbs
    : (options.baseUrl ?? options.pathsDir ?? rootAbs);

  const rules = [];
  for (const [pattern, values] of Object.entries(source)) {
    const wildcard = pattern.includes("*");
    const [prefix, suffix = ""] = pattern.split("*");
    const targets = []
      .concat(values)
      .map((v) => toRel(rootAbs, resolve(baseDir, v)))
      .filter((t) => !t.startsWith(".."));
    rules.push({ pattern, wildcard, prefix, suffix, targets });
  }
  // The longest matching prefix wins, as in the TypeScript resolver.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  return { rules, baseUrl: baseUrl === "" ? "." : baseUrl, warnings };
}

export function aliasCandidates(spec, config) {
  if (
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(spec)
  ) {
    return [];
  }
  const out = [];
  for (const rule of config.rules) {
    if (rule.wildcard) {
      const fits =
        spec.length >= rule.prefix.length + rule.suffix.length &&
        spec.startsWith(rule.prefix) &&
        spec.endsWith(rule.suffix);
      if (!fits) continue;
      const captured = spec.slice(
        rule.prefix.length,
        spec.length - rule.suffix.length
      );
      for (const t of rule.targets)
        out.push(posix.normalize(t.replace("*", captured)));
    } else if (spec === rule.pattern) {
      for (const t of rule.targets) out.push(posix.normalize(t));
    }
  }
  if (config.baseUrl !== null)
    out.push(posix.normalize(posix.join(config.baseUrl, spec)));
  return out;
}

function existsAmong(fileSet, p) {
  if (fileSet.has(p)) return true;
  return PROBE_EXT.some(
    (e) => fileSet.has(p + e) || fileSet.has(`${p}/index${e}`)
  );
}

function rewriteSource(source, fromRel, config, fileSet, onRewrite) {
  return source.replace(SPECIFIER, (whole, lead, quote, spec) => {
    const mapped = aliasCandidates(spec, config).find((c) =>
      existsAmong(fileSet, c)
    );
    if (mapped === undefined) return whole;
    let rel = posix.relative(posix.dirname(fromRel), mapped);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    onRewrite();
    return `${lead}${quote}${rel}${quote}`;
  });
}

function listTracked(root) {
  return git(root, ["ls-files", "-z"])
    .split("\0")
    .filter((p) => p && isRegularFile(join(root, p)));
}

function isRegularFile(abs) {
  try {
    return statSync(abs).isFile();
  } catch {
    return false;
  }
}

export function walkFiles(root, skipRel = null) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (WALK_SKIP.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = toRel(root, abs);
      if (rel === skipRel) continue;
      if (entry.isDirectory()) visit(abs);
      else if (isRegularFile(abs)) found.push(rel);
    }
  };
  visit(root);
  return found.sort();
}

export async function analyzeProject({
  root,
  outDir,
  label,
  exclude,
  aliases,
  trackedOnly,
  churnSince = "180 days ago",
} = {}) {
  if (!root) throw new Error("analyzeProject needs a root directory");
  const rootAbs = resolve(root);
  if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    throw new Error(`root is not a directory: ${rootAbs}`);
  }
  const name = label ?? basename(rootAbs);
  const stem = name.replace(/[\\/]/g, "_");
  const out = outDir ? resolve(outDir) : join(rootAbs, ".codeflow");
  const inGit = isGitRepo(rootAbs);
  const tracked = trackedOnly ?? inGit;
  if (tracked && !inGit) {
    throw new Error("trackedOnly needs a git repository at root");
  }

  const files = tracked
    ? listTracked(rootAbs)
    : walkFiles(rootAbs, toRel(rootAbs, out));
  const fileSet = new Set(files);
  const config = loadAliasConfig(rootAbs, aliases);
  const rewriting = config.rules.length > 0 || config.baseUrl !== null;

  const scratch = mkdtempSync(join(tmpdir(), "codeflow-headless-"));
  let rewritten = 0;
  try {
    for (const file of files) {
      const dest = join(scratch, file);
      mkdirSync(dirname(dest), { recursive: true });
      if (rewriting && REWRITE_EXT.test(file)) {
        const source = readFileSync(join(rootAbs, file), "utf8");
        const next = rewriteSource(
          source,
          file,
          config,
          fileSet,
          () => rewritten++
        );
        writeFileSync(dest, next);
      } else {
        copyFileSync(join(rootAbs, file), dest);
      }
    }

    const { analyze } = require("../lib/analysis.js");
    const envelope = await analyze({ repoRoot: scratch, exclude });

    mkdirSync(out, { recursive: true });
    const base = join(out, stem);
    const envelopePath = `${base}.json`;
    writeFileSync(envelopePath, JSON.stringify(envelope));

    let hotspots = null;
    const outputs = { envelope: envelopePath };
    if (inGit) {
      hotspots = buildHotspots(envelope.data, rootAbs, churnSince);
      outputs.hotspots = `${base}.hotspots.json`;
      writeFileSync(outputs.hotspots, JSON.stringify(hotspots, null, 2));
    }
    const report = renderReport({
      envelope,
      label: name,
      base,
      hotspots,
      aliasRewrites: rewritten,
    });
    Object.assign(outputs, report.files);

    const { snapshot } = envelope;
    return {
      label: name,
      outDir: out,
      trackedOnly: tracked,
      rewrittenAliasImports: rewritten,
      warnings: config.warnings,
      grade: report.health.grade,
      score: report.health.score,
      files: snapshot.files,
      connections: snapshot.connections,
      layerViolations: snapshot.layerViolations,
      securityIssues: snapshot.securityIssues,
      hotspotCount: hotspots ? hotspots.rows.length : 0,
      topHotspots: hotspots
        ? hotspots.rows.slice(0, 5).map((r) => `${r.path} (${r.hotspot})`)
        : [],
      outputs,
      envelope,
      hotspots,
      health: { health: report.health, breakdown: report.breakdown },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
