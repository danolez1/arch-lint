// CodeFlow links calls by bare name, so its structural findings are re-checked against the files on disk.
import { readFileSync, statSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { aliasCandidates, loadAliasConfig, walkFiles } from "./analyze.mjs";
import { git, gitIgnoredPaths, isGitRepo } from "./hotspots.mjs";
import { loadCore } from "./report.mjs";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const stripExt = (p) =>
  p
    .replace(/\.(d\.ts|[cm]?[jt]sx?|py|rs|go|dart|vue|svelte)$/, "")
    .replace(/\/(index|__init__|mod)$/, "");

const IMPORT_FORMS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /^\s*from\s+([\w.]+)\s+import\b/gm,
  /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?\s*$/gm,
  /\/\/\/\s*<reference\s+path=['"]([^'"]+)['"]/g,
  /^\s*use\s+(?:crate::)?([\w:]+)/gm,
  /^\s*import\s+['"]package:[\w_]+\/([^'"]+)['"]/gm,
];

function specifiers(content) {
  const out = [];
  for (const re of IMPORT_FORMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content))) out.push(m[1]);
  }
  return out;
}

// detectLayer returns "utils" for every unrecognised path, so a "utils" layer without a utility-looking folder is a default, not a rule.
function layerIsFallback(p, layer) {
  if (layer !== "utils") return false;
  const l = `/${p.toLowerCase()}`;
  return !(
    l.includes("/util") ||
    l.includes("/helper") ||
    l.includes("/lib/") ||
    l.includes("/common/") ||
    l.includes("/standard/")
  );
}

const tally = (rows) =>
  rows.reduce((m, x) => ((m[x.verdict] = (m[x.verdict] || 0) + 1), m), {});

export function verifyFindings({ root, envelope, ignoredPaths, aliases } = {}) {
  if (!root || !envelope?.data) {
    throw new Error("verifyFindings needs root and an analysis envelope");
  }
  const repo = resolve(root);
  const data = envelope.data;
  const inGit = isGitRepo(repo);
  const { Parser } = loadCore();

  const ignored = ignoredPaths
    ? new Set(ignoredPaths)
    : inGit
      ? gitIgnoredPaths(
          repo,
          data.files.map((f) => f.path)
        )
      : new Set();
  const inScope = (p) => !!p && !ignored.has(p);

  const diskFiles = inGit
    ? git(repo, [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ])
        .split("\0")
        .filter(Boolean)
    : walkFiles(repo);

  const contentCache = new Map();
  function read(p) {
    if (!contentCache.has(p)) {
      let c = null;
      try {
        const full = join(repo, p);
        if (statSync(full).size <= MAX_FILE_BYTES)
          c = readFileSync(full, "utf8");
      } catch {
        c = null;
      }
      contentCache.set(p, c);
    }
    return contentCache.get(p);
  }

  const grepCache = new Map();
  function grepWord(word) {
    if (grepCache.has(word)) return grepCache.get(word);
    let lines;
    if (inGit) {
      try {
        lines = git(repo, [
          "grep",
          "--untracked",
          "-n",
          "-I",
          "-w",
          "-F",
          "-e",
          word,
        ])
          .split("\n")
          .filter(Boolean);
      } catch (err) {
        if (err.status !== 1) throw err;
        lines = [];
      }
    } else {
      const re = new RegExp(`(?<![\\w$])${escRe(word)}(?![\\w$])`);
      lines = [];
      for (const p of diskFiles) {
        const c = read(p);
        if (!c) continue;
        c.split("\n").forEach((text, i) => {
          if (re.test(text)) lines.push(`${p}:${i + 1}:${text}`);
        });
      }
    }
    const hits = lines
      .map((l) => {
        const m = l.match(/^(.*?):(\d+):(.*)$/);
        return m
          ? { file: m[1], line: Number(m[2]), text: m[3].trim().slice(0, 160) }
          : null;
      })
      .filter(Boolean);
    grepCache.set(word, hits);
    return hits;
  }

  // Unused functions: a hit anywhere outside the definition line means the heuristic missed a caller.
  const dead = data.deadFunctions
    .filter((f) => inScope(f.file))
    .map((fn) => {
      const base = fn.name.includes(".") ? fn.name.split(".").pop() : fn.name;
      const defRe = new RegExp(
        `\\b(?:def|function|fn|func|fun|sub|proc|class|const|let|var|async\\s+function)\\s+${escRe(base)}\\b`
      );
      const refs = grepWord(base)
        .filter(
          (h) =>
            !(h.file === fn.file && h.line === fn.line) && !defRe.test(h.text)
        )
        .filter((h) => inScope(h.file));
      const found = refs.length > 0;
      return {
        kind: "unused-function",
        name: fn.name,
        file: fn.file,
        line: fn.line,
        codeLines: fn.codeLines,
        verdict: found ? "FALSE_POSITIVE" : "CONFIRMED",
        reason: found
          ? `${refs.length} reference(s) to \`${base}\` outside its definition`
          : `no reference to \`${base}\` in tracked or untracked non-ignored files besides its definition`,
        evidence: refs.slice(0, 5),
      };
    });

  // Layer violations: only real import statements count; name-matched call edges and fallback layers do not.
  const pathIndex = Parser.buildCallGraphPathIndex(
    data.files.map((f) => ({ path: f.path, name: f.name }))
  );
  const importCache = new Map();
  function importTargets(p) {
    if (!importCache.has(p)) {
      const c = read(p);
      importCache.set(
        p,
        c
          ? Parser.extractCallGraphImportMap(c, p, pathIndex).targets
          : new Set()
      );
    }
    return importCache.get(p);
  }

  // The analyzer resolver misses path aliases, Python package imports and workspace packages, so specifiers are matched here.
  const workspacePkgs = [];
  for (const f of diskFiles) {
    if (basename(f) !== "package.json" || f.includes("node_modules/")) continue;
    try {
      const name = JSON.parse(readFileSync(join(repo, f), "utf8")).name;
      if (name) workspacePkgs.push({ name, dir: posix.dirname(f) });
    } catch {
      // A malformed manifest only costs the workspace-package match for that directory.
    }
  }
  workspacePkgs.sort((a, b) => b.name.length - a.name.length);
  const aliasConfig = loadAliasConfig(repo, aliases);

  function importsFile(from, to) {
    if (importTargets(from).has(to))
      return { real: true, via: "CodeFlow import map" };
    const c = read(from);
    if (!c) return { real: false };
    const target = stripExt(to);
    for (const spec of specifiers(c)) {
      if (spec.startsWith(".")) {
        let cand;
        if (/^\.+\w/.test(spec) && !spec.includes("/")) {
          const up = spec.match(/^\.+/)[0].length;
          cand = posix.join(
            posix.dirname(from),
            ...Array(up - 1).fill(".."),
            spec.slice(up).replace(/\./g, "/")
          );
        } else {
          cand = posix.join(posix.dirname(from), spec);
        }
        if (stripExt(cand) === target) return { real: true, via: spec };
        continue;
      }
      if (
        aliasCandidates(spec, aliasConfig).some((a) => stripExt(a) === target)
      ) {
        return { real: true, via: spec };
      }
      const pkg = workspacePkgs.find(
        (w) => spec === w.name || spec.startsWith(`${w.name}/`)
      );
      if (pkg) {
        const sub = spec.slice(pkg.name.length).replace(/^\//, "");
        const hit = sub
          ? target.endsWith(`/${stripExt(sub)}`) && to.startsWith(`${pkg.dir}/`)
          : to.startsWith(`${pkg.dir}/`);
        if (hit) return { real: true, via: spec };
        continue;
      }
      const norm = stripExt(
        spec
          .replace(/^[@~]\//, "")
          .replace(/::/g, "/")
          .replace(/^(?![\w-]+\/)(\w+(?:\.\w+)+)$/, (s) =>
            s.replace(/\./g, "/")
          )
      );
      if (norm && (target === norm || target.endsWith(`/${norm}`))) {
        return { real: true, via: spec };
      }
    }
    return { real: false };
  }

  const layer = data.layerViolations
    .filter((v) => inScope(v.from) && inScope(v.to))
    .map((v) => {
      const imp = importsFile(v.from, v.to);
      const fromFallback = layerIsFallback(v.from, v.fromLayer);
      const toFallback = layerIsFallback(v.to, v.toLayer);
      let verdict;
      let reason;
      if (!imp.real) {
        verdict = "FALSE_POSITIVE";
        reason = `\`${v.from}\` has no import of \`${v.to}\`; edge came from a bare-name match on \`${v.fn}\``;
      } else if (fromFallback || toFallback) {
        verdict = "FALSE_POSITIVE";
        reason = `import is real, but ${fromFallback ? `\`${v.from}\`` : `\`${v.to}\``} got layer \`utils\` only as the default for unmatched paths, so no layering rule is broken`;
      } else {
        verdict = "NEEDS_REVIEW";
        reason = `real import from ${v.fromLayer} into ${v.toLayer}; both layers come from folder names`;
      }
      if (imp.real) reason += ` (import \`${imp.via}\`)`;
      return {
        kind: "layer-violation",
        from: v.from,
        fromLayer: v.fromLayer,
        to: v.to,
        toLayer: v.toLayer,
        fn: v.fn,
        verdict,
        reason,
      };
    });

  // Circular deps: CodeFlow only flags imports in both directions, but aliased ones are invisible to it on the raw tree.
  const circIssue = data.issues.find((i) => i.title.includes("Circular"));
  const lineOf = (file, target) => {
    const lines = (read(file) || "").split("\n");
    const stem = basename(target).replace(/\.[^.]+$/, "");
    const idx = lines.findIndex(
      (l) => /\b(import|from|require|use|include)\b/.test(l) && l.includes(stem)
    );
    return idx >= 0
      ? `${file}:${idx + 1} ${lines[idx].trim().slice(0, 160)}`
      : null;
  };
  const circular = (circIssue ? circIssue.items : [])
    .filter((i) => i.files.every(inScope))
    .map((i) => {
      const [a, b] = i.files;
      const both = importsFile(a, b).real && importsFile(b, a).real;
      return {
        kind: "circular-dependency",
        files: i.files,
        verdict: both ? "CONFIRMED" : "FALSE_POSITIVE",
        reason: both
          ? "both files import each other"
          : "import missing in one direction on current disk state",
        evidence: [lineOf(a, b), lineOf(b, a)].filter(Boolean),
      };
    });

  // Duplicate names are only a smell when bodies are also similar; "code" is CodeFlow's own similar-body type.
  const dups = data.duplicates
    .filter((d) => (d.files || []).some((f) => inScope(f.file)))
    .map((d) => {
      const files = (d.files || []).filter((f) => inScope(f.file));
      const distinctFiles = new Set(files.map((f) => f.file)).size;
      let verdict;
      let reason;
      if (d.type === "code") {
        verdict = "NEEDS_REVIEW";
        reason = `similar function bodies (${d.similarity}%)`;
      } else if (distinctFiles < 2) {
        verdict = "FALSE_POSITIVE";
        reason =
          "after dropping gitignored copies only one in-scope file remains";
      } else if ((d.similarity || 0) < 70) {
        verdict = "FALSE_POSITIVE";
        reason = `same name, bodies only ${d.similarity}% similar; common names like this are not duplication`;
      } else {
        verdict = "NEEDS_REVIEW";
        reason = `same name and ${d.similarity}% similar bodies across ${distinctFiles} files`;
      }
      return {
        kind: "duplicate",
        type: d.type,
        name: d.name,
        similarity: d.similarity,
        files,
        verdict,
        reason,
      };
    });

  return {
    generatedAt: new Date().toISOString(),
    ignoredPaths: Array.from(ignored),
    dead,
    layer,
    circular,
    dups,
    tally: {
      dead: tally(dead),
      layer: tally(layer),
      circular: tally(circular),
      dups: tally(dups),
    },
  };
}
