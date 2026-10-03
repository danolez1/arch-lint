// CodeFlow's markdown export truncates long lists, so the full report is rebuilt here from the envelope.
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";

const require = createRequire(import.meta.url);

let core;
// The analyzer shipped with this package is always the one used, never one found in the analyzed tree.
export function loadCore() {
  if (!core) {
    const { loadAnalyzer, locateCoreSource } = require("../lib/analyzer.js");
    core = loadAnalyzer(locateCoreSource());
  }
  return core;
}

const id = (x) => (typeof x === "object" && x ? x.id : x);
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
// A zero-width space breaks any triple backtick inside a code sample without changing how it reads.
const fence = (code) =>
  `\`\`\`\n${String(code).replace(/```/g, "`​``")}\n\`\`\`\n`;
const anchor = (title) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

export function blastRadii(data) {
  const exportedTo = new Map();
  const importedFrom = new Map();
  const exportedFns = new Map();
  for (const c of data.connections) {
    const src = id(c.source);
    const tgt = id(c.target);
    if (!exportedTo.has(src)) exportedTo.set(src, new Set());
    exportedTo.get(src).add(tgt);
    if (!importedFrom.has(tgt)) importedFrom.set(tgt, new Set());
    importedFrom.get(tgt).add(src);
    if (!exportedFns.has(src)) exportedFns.set(src, new Map());
    const m = exportedFns.get(src);
    m.set(c.fn, (m.get(c.fn) || 0) + (c.count || 1));
  }
  const connectedFiles = data.files.filter(
    (f) => exportedTo.has(f.path) || importedFrom.has(f.path)
  ).length;

  // Same walk as calcBlast in the core, but the adjacency is built once instead of per call.
  function blast(fileId) {
    const direct = exportedTo.has(fileId)
      ? Array.from(exportedTo.get(fileId))
      : [];
    const transitive = new Map();
    const queue = direct.map((f) => ({ file: f, depth: 1 }));
    const visited = new Set([fileId, ...direct]);
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (item.depth > 3) continue;
      transitive.set(item.file, item.depth);
      for (const f of exportedTo.get(item.file) || []) {
        if (!visited.has(f)) {
          visited.add(f);
          queue.push({ file: f, depth: item.depth + 1 });
        }
      }
    }
    const fnUsage = exportedFns.get(fileId) || new Map();
    let totalCalls = 0;
    fnUsage.forEach((n) => (totalCalls += n));
    const deps = importedFrom.has(fileId)
      ? Array.from(importedFrom.get(fileId))
      : [];
    let impact = direct.length;
    transitive.forEach((d) => {
      if (d > 1) impact += 1 / d;
    });
    let level = "low";
    if (direct.length >= 8 || fnUsage.size >= 5) level = "critical";
    else if (direct.length >= 4 || fnUsage.size >= 3) level = "high";
    else if (direct.length >= 2 || fnUsage.size >= 1) level = "medium";
    return {
      affected: direct,
      transitive: Array.from(transitive.keys()),
      count: direct.length,
      transitiveCount: transitive.size,
      percent:
        connectedFiles > 0
          ? Math.round((direct.length / connectedFiles) * 100)
          : 0,
      level,
      depth: transitive.size > 0 ? Math.max(...transitive.values()) : 0,
      fnsUsed: fnUsage.size,
      totalCalls,
      dependencies: deps,
      impactScore: Math.round(impact * 10) / 10,
      centrality: direct.length + deps.length + fnUsage.size,
    };
  }

  return data.files.map((f) => ({ path: f.path, ...blast(f.path) }));
}

const BLAST_FIELDS = [
  "count",
  "transitiveCount",
  "percent",
  "level",
  "depth",
  "fnsUsed",
  "totalCalls",
  "impactScore",
  "centrality",
];

// Spot-check the reimplementation so a change in the core formula fails loudly instead of drifting.
function assertBlastMatchesCore(data, blasts) {
  const { calcBlast } = loadCore();
  const probe = blasts
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .concat(blasts.slice(0, 2));
  for (const b of probe) {
    const ref = calcBlast(b.path, data.connections, data.files);
    for (const k of BLAST_FIELDS) {
      if (ref[k] !== b[k]) {
        throw new Error(
          `blast drift on ${b.path} field ${k}: ${ref[k]} vs ${b[k]}`
        );
      }
    }
  }
}

export function healthBreakdown(data) {
  const { calcHealth } = loadCore();
  const health = calcHealth(data);
  const deadPct =
    data.stats.functions > 0
      ? (data.stats.dead / data.stats.functions) * 100
      : 0;
  const circularN = data.issues.filter((i) =>
    i.title.includes("Circular")
  ).length;
  const godN = data.issues.filter((i) => i.title.includes("Large")).length;
  const avgCoup =
    data.stats.files > 0 ? data.stats.connections / data.stats.files : 0;
  const highSec = data.securityIssues.filter(
    (i) => i.severity === "high"
  ).length;
  const breakdown = [
    {
      factor: "Dead code",
      measured: `${deadPct.toFixed(2)}% of functions`,
      penalty: -Math.min(20, deadPct),
      cap: 20,
    },
    {
      factor: "Circular dependency issues",
      measured: circularN,
      penalty: -Math.min(20, circularN * 5),
      cap: 20,
    },
    {
      factor: "Large-file issues",
      measured: godN,
      penalty: -Math.min(15, godN * 3),
      cap: 15,
    },
    {
      factor: "Average coupling",
      measured: `${avgCoup.toFixed(2)} connections/file`,
      penalty: -Math.min(15, Math.max(0, avgCoup - 3) * 2),
      cap: 15,
    },
    {
      factor: "High-severity security issues",
      measured: highSec,
      penalty: -Math.min(20, highSec * 5),
      cap: 20,
    },
  ];
  const recomputed = Math.max(
    0,
    Math.round(breakdown.reduce((s, b) => s + b.penalty, 100))
  );
  if (recomputed !== health.score) {
    throw new Error(
      `health drift: breakdown gives ${recomputed}, core gives ${health.score}`
    );
  }
  return { health, breakdown };
}

function writeTable(w, items) {
  if (!items.length) return;
  const keys = Array.from(new Set(items.flatMap((x) => Object.keys(x)))).filter(
    (k) => k !== "code"
  );
  w(`| # | ${keys.join(" | ")} |\n|---|${keys.map(() => "---").join("|")}|\n`);
  items.forEach((x, i) =>
    w(
      `| ${i + 1} | ${keys.map((k) => esc(typeof x[k] === "object" ? JSON.stringify(x[k]) : x[k])).join(" | ")} |\n`
    )
  );
  w("\n");
}

const SECTIONS = [
  "Summary",
  "Health score breakdown",
  "Hotspots",
  "Snapshot",
  "Languages",
  "Parser modes",
  "Suggestions",
  "Security issues",
  "Architecture issues",
  "Patterns and anti-patterns",
  "Duplicates",
  "Layer violations",
  "Unused functions",
  "Architecture diagram",
  "Blast radius, every file",
  "Files",
  "Folders",
  "Dependencies",
  "Function statistics",
];

export function renderReport({
  envelope,
  label,
  base,
  hotspots = null,
  aliasRewrites = 0,
}) {
  const { data, snapshot: snap } = envelope;
  const name = label || basename(base);

  const blasts = blastRadii(data);
  assertBlastMatchesCore(data, blasts);
  const { health, breakdown } = healthBreakdown(data);

  const sections = SECTIONS.filter((s) => s !== "Hotspots" || hotspots);
  const reportPath = `${base}.full-report.md`;
  const out = openSync(reportPath, "w");
  const w = (s) => writeSync(out, s);

  try {
    w(`# CodeFlow full analysis: ${name}\n\n`);
    const at = hotspots?.head ? ` at ${hotspots.head}` : "";
    const aliasNote =
      aliasRewrites > 0
        ? `, ${aliasRewrites} alias imports rewritten to relative paths`
        : "";
    w(
      `Analyzed ${snap.at}${at} with the CodeFlow headless analyzer${aliasNote}.\n`
    );
    w("Every list below is complete. Nothing is truncated.\n\n");

    w("## Contents\n\n");
    sections.forEach((s) => w(`- [${s}](#${anchor(s)})\n`));
    w("\n");

    w("## Summary\n\n| Metric | Value |\n|---|---|\n");
    w(`| Health score | ${health.score}/100 (${health.grade}) |\n`);
    for (const [k, v] of Object.entries(data.stats)) {
      if (Array.isArray(v)) continue;
      w(`| ${k} | ${v} |\n`);
    }
    w(
      `| securityIssues (all severities) | ${data.securityIssues.length} |\n\n`
    );

    w(
      "## Health score breakdown\n\nStart at 100 and subtract each penalty, using the same formula as `calcHealth` in the analyzer core.\n\n| Factor | Measured | Penalty | Cap |\n|---|---|---|---|\n"
    );
    breakdown.forEach((b) =>
      w(
        `| ${b.factor} | ${b.measured} | ${b.penalty.toFixed(2)} | ${b.cap} |\n`
      )
    );

    if (hotspots) {
      w(
        `\n## Hotspots\n\nChurn is commits touching the file since ${hotspots.since}; hotspot is churn times CodeFlow's complexity score.\n\n`
      );
      if (hotspots.rows.length) {
        w(
          "| # | File | Hotspot | Churn | Complexity | Lines | Authors |\n|---|---|---|---|---|---|---|\n"
        );
        hotspots.rows.forEach((r, i) =>
          w(
            `| ${i + 1} | \`${esc(r.path)}\` | ${r.hotspot} | ${r.churn} | ${r.complexity} | ${r.lines} | ${r.authors} |\n`
          )
        );
      } else {
        w("No file has both churn and complexity in this window.\n");
      }
    }

    w(`\n## Snapshot\n\n${fence(JSON.stringify(snap, null, 2))}\n`);

    w("## Languages\n\n| Ext | Lines | % |\n|---|---|---|\n");
    data.stats.languages.forEach((l) =>
      w(`| ${l.ext} | ${l.lines} | ${l.pct} |\n`)
    );

    w("\n## Parser modes\n\n| Mode | Files |\n|---|---|\n");
    (data.stats.parserModes || []).forEach((m) =>
      w(`| ${m.mode} | ${m.files} |\n`)
    );

    w("\n## Suggestions\n\n");
    data.suggestions.forEach((s) =>
      w(
        `- [${s.priority}] ${s.title}. ${s.desc} Action: ${s.action}. Impact: ${s.impact}.\n`
      )
    );

    w(`\n## Security issues\n\n${data.securityIssues.length} total.\n\n`);
    const bySeverity = {};
    data.securityIssues.forEach(
      (s) => (bySeverity[s.severity] = (bySeverity[s.severity] || 0) + 1)
    );
    w("| Severity | Count |\n|---|---|\n");
    Object.entries(bySeverity).forEach(([k, v]) => w(`| ${k} | ${v} |\n`));
    w(
      "\n| # | Severity | Title | Path | Line | Description | Code |\n|---|---|---|---|---|---|---|\n"
    );
    data.securityIssues.forEach((s, i) =>
      w(
        `| ${i + 1} | ${s.severity} | ${esc(s.title)} | \`${esc(s.path)}\` | ${s.line || ""} | ${esc(s.desc)} | ${s.code ? `\`${esc(s.code)}\`` : ""} |\n`
      )
    );

    w("\n## Architecture issues\n\n");
    data.issues.forEach((iss) => {
      w(`### [${iss.type}] ${iss.title}\n\n${iss.desc}\n\n`);
      writeTable(w, iss.items || []);
    });

    w("## Patterns and anti-patterns\n\n");
    data.patterns.forEach((p) => {
      w(
        `### ${p.isAnti ? "[anti-pattern] " : ""}${p.name} (${p.severity}, ${p.files.length} files)\n\n${p.desc}\n\nMetrics: \`${JSON.stringify(p.metrics || {})}\`\n\n`
      );
      writeTable(w, p.files);
    });

    w(`## Duplicates\n\n${data.duplicates.length} groups.\n\n`);
    data.duplicates.forEach((d, i) => {
      w(
        `### ${i + 1}. \`${d.name}\` (${d.type}, ${d.count} files, ${d.similarity}% similarity)\n\n${d.suggestion}\n\n`
      );
      (d.files || []).forEach((f) => w(`- \`${f.file}\`:${f.line}\n`));
      w("\n");
    });

    w(
      `## Layer violations\n\n${data.layerViolations.length} total. Layers are guessed from folder names, so read these as leads.\n\n`
    );
    w(
      "| # | From | From layer | To | To layer | Fn | Suggestion |\n|---|---|---|---|---|---|---|\n"
    );
    data.layerViolations.forEach((v, i) =>
      w(
        `| ${i + 1} | \`${esc(v.from)}\` | ${v.fromLayer} | \`${esc(v.to)}\` | ${v.toLayer} | ${esc(v.fn)} | ${esc(v.suggestion)} |\n`
      )
    );

    w(
      `\n## Unused functions\n\n${data.deadFunctions.length} total. Zero internal or external calls found by the heuristic; unused is not proof of dead.\n\n`
    );
    data.deadFunctions.forEach((fn, i) => {
      w(
        `### ${i + 1}. \`${fn.name}()\`\n\n\`${fn.file}\`:${fn.line}, ${fn.codeLines} lines, ${fn.ext}\n\n`
      );
      if (fn.code) w(`${fence(fn.code)}\n`);
    });

    const ad = data.architectureDiagram;
    w(
      `## Architecture diagram\n\nFramework: ${ad.framework}, profile: ${ad.profile}, type: ${ad.type}\n\n`
    );
    if (ad.mermaid) w(`\`\`\`mermaid\n${ad.mermaid}\n\`\`\`\n\n`);
    w(`Full diagram object:\n\n${fence(JSON.stringify(ad, null, 2))}\n`);

    w(
      `## Blast radius, every file\n\nSorted by direct dependents, then transitive (depth capped at 3, same as the app). Full affected, transitive and dependency lists are in \`${basename(base)}.blast.json\`.\n\n`
    );
    w(
      "| # | File | Level | Direct | Transitive | Max depth | % of connected | Fns used | Total calls | Imports from | Impact | Centrality |\n|---|---|---|---|---|---|---|---|---|---|---|---|\n"
    );
    blasts
      .slice()
      .sort(
        (a, b) =>
          b.count - a.count ||
          b.transitiveCount - a.transitiveCount ||
          a.path.localeCompare(b.path)
      )
      .forEach((b, i) =>
        w(
          `| ${i + 1} | \`${esc(b.path)}\` | ${b.level} | ${b.count} | ${b.transitiveCount} | ${b.depth} | ${b.percent} | ${b.fnsUsed} | ${b.totalCalls} | ${b.dependencies.length} | ${b.impactScore} | ${b.centrality} |\n`
        )
      );

    w(
      `\n## Files\n\n${data.files.length} total.\n\n| # | Path | Layer | Lines | Functions | Code | Complexity | Parser | Deps |\n|---|---|---|---|---|---|---|---|---|\n`
    );
    data.files.forEach((f, i) =>
      w(
        `| ${i + 1} | \`${esc(f.path)}\` | ${f.layer} | ${f.lines} | ${f.functions.length} | ${f.isCode !== false} | ${f.complexity ? `${f.complexity.score} ${f.complexity.level}` : ""} | ${f.parserProvenance || ""} | ${(f.dependencies || []).length} |\n`
      )
    );

    const folders = data.folders || [];
    w(`\n## Folders\n\n${folders.length} total.\n\n`);
    folders.forEach((f) =>
      w(`- \`${typeof f === "object" ? JSON.stringify(f) : f}\`\n`)
    );

    w(
      `\n## Dependencies\n\n${data.connections.length} edges. Source defines the function, target calls it.\n\n| # | Source | Target | Fn | Calls |\n|---|---|---|---|---|\n`
    );
    data.connections.forEach((c, i) =>
      w(
        `| ${i + 1} | \`${esc(id(c.source))}\` | \`${esc(id(c.target))}\` | ${esc(c.fn)} | ${c.count} |\n`
      )
    );

    const fnStats = Object.values(data.fnStats || {});
    w(
      `\n## Function statistics\n\n${fnStats.length} functions.\n\n| # | Name | File | Line | Type | Internal | External | Exported | Class method | Top level | Callers |\n|---|---|---|---|---|---|---|---|---|---|---|\n`
    );
    fnStats.forEach((s, i) =>
      w(
        `| ${i + 1} | ${esc(s.name)} | \`${esc(s.file)}\` | ${s.line} | ${s.type} | ${s.internal} | ${s.external} | ${s.isExported} | ${s.isClassMethod} | ${s.isTopLevel} | ${esc((s.callers || []).map((c) => `${c.file}#${c.name}x${c.count}`).join(", "))} |\n`
      )
    );
  } finally {
    closeSync(out);
  }

  const blastPath = `${base}.blast.json`;
  const healthPath = `${base}.health.json`;
  writeFileSync(blastPath, JSON.stringify(blasts));
  writeFileSync(healthPath, JSON.stringify({ health, breakdown }, null, 2));
  return {
    health,
    breakdown,
    blasts,
    files: { report: reportPath, blast: blastPath, health: healthPath },
  };
}
