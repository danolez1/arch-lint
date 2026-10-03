// Turns verification verdicts into a readable audit write-up; hand-checked facts arrive as data, never as prose here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { git, gitHead, isGitRepo } from "./hotspots.mjs";
import { healthBreakdown, loadCore } from "./report.mjs";

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");
// Credentials in URLs are masked so the document is safe to paste elsewhere.
const redact = (s) => String(s).replace(/(:\/\/[^:/\s]+:)[^@\s]+@/g, "$1***@");
const minus = (n, digits) =>
  n ? `-${digits === undefined ? n : n.toFixed(digits)}` : "0";
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}...` : s);
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\./;
const LIB_ROOT =
  "importer sits under a `lib/` folder, which the analyzer's layer detection maps to `utils` even when it holds application code, so a utils-to-other-layer violation is not a reliable signal";

// Reviewers get the analyzer's own words, so punctuation the house style bans is flattened at the end.
function sanitize(doc) {
  return doc
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "");
}

function currentBranch(root) {
  try {
    return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return null;
  }
}

export function renderAudit({
  root,
  envelope,
  verdicts,
  health,
  hotspots = null,
  ignoredPaths,
  label,
  security = null,
  overrides = {},
  notes = [],
  generatedPaths = [],
  idPrefix,
  scanDate,
  outPath,
} = {}) {
  if (!root || !envelope?.data || !verdicts) {
    throw new Error("renderAudit needs root, envelope and verdicts");
  }
  const repo = resolve(root);
  const data = envelope.data;
  const name = label || basename(repo);
  const P = idPrefix || (name.match(/[a-z0-9]/i)?.[0] ?? "X").toUpperCase();
  const date = scanDate || String(envelope.snapshot?.at ?? "").slice(0, 10);
  const { Parser } = loadCore();
  const hp = health ?? healthBreakdown(data);

  const analyzed = new Set(data.files.map((f) => f.path));
  const ignored = new Set(
    Array.from(ignoredPaths ?? verdicts.ignoredPaths ?? []).filter((p) =>
      analyzed.has(p)
    )
  );
  const inScope = (p) => !!p && !ignored.has(p);

  const inGit = isGitRepo(repo);
  const head = inGit ? gitHead(repo) : null;
  const branch = inGit ? currentBranch(repo) : null;

  const readLines = (p) => {
    try {
      return readFileSync(join(repo, p), "utf8").split("\n");
    } catch {
      return [];
    }
  };
  const generatedUnder = (p) => generatedPaths.find((g) => p.startsWith(g));

  // Framework conventions and doc examples make an unreferenced function legitimate without any importer.
  function deadRule(fn) {
    const lines = readLines(fn.file);
    const def = (lines[fn.line - 1] || "").trim();
    const generated = generatedUnder(fn.file);
    if (generated)
      return `function belongs to generated output under \`${generated}\`, not project source`;
    if (/^(\*|\/\/|#)/.test(def)) {
      return `definition is inside a doc comment example (${fn.file}:${fn.line} starts with \`${def.slice(0, 2)}\`)`;
    }
    if (
      /\/app\/(.*\/)?(page|layout|route|loading|error|not-found|template|default)\.[jt]sx?$/.test(
        `/${fn.file}`
      ) &&
      /export\s+default/.test(def)
    ) {
      return "Next.js App Router loads the default export of this file by convention; no import is expected";
    }
    if (fn.file.endsWith(".py")) {
      for (let i = fn.line - 2; i >= 0 && i >= fn.line - 20; i--) {
        const l = (lines[i] ?? "").trim();
        if (/^(async\s+)?def\s/.test(l)) break;
        if (
          /^@\w+\.(get|post|put|patch|delete|api_route|websocket)\(/.test(l)
        ) {
          return `FastAPI registers it through the decorator at ${fn.file}:${i + 1} (${l.slice(0, 40)})`;
        }
      }
    }
    return null;
  }

  const dead = verdicts.dead.map((d) => {
    const hand = overrides.dead?.[`${d.file}:${d.name}`];
    if (hand) return { ...d, ...hand };
    if (d.verdict === "CONFIRMED") {
      const rule = deadRule(d);
      if (rule) return { ...d, verdict: "FALSE_POSITIVE", reason: rule };
      return {
        ...d,
        severity: "low",
        fix: "confirm intent with the owner, then delete or wire it in (unused is not proof of dead)",
      };
    }
    const e = d.evidence[0];
    return { ...d, reason: d.reason + (e ? `; e.g. ${e.file}:${e.line}` : "") };
  });

  const layer = verdicts.layer.map((l) => {
    const hand = overrides.layer?.[`${l.from}>${l.to}`];
    if (hand) return { ...l, ...hand };
    if (l.verdict === "NEEDS_REVIEW" && /(^|\/)lib\//.test(l.from)) {
      const at = l.reason.lastIndexOf(" (import");
      return {
        ...l,
        verdict: "FALSE_POSITIVE",
        reason: LIB_ROOT + (at >= 0 ? l.reason.slice(at) : ""),
      };
    }
    return l;
  });

  const circular = verdicts.circular.map((c) => ({ ...c, severity: "low" }));

  // CodeFlow scores only the first two members of a fingerprint group, so every pair is scored here.
  const codeAt = new Map();
  for (const f of data.files) {
    for (const fn of f.functions || [])
      codeAt.set(`${f.path}:${fn.line}`, fn.code);
  }
  const dups = verdicts.dups.map((d) => {
    if (d.verdict === "FALSE_POSITIVE") return d;
    const members = d.files.filter((f) => codeAt.get(`${f.file}:${f.line}`));
    if (
      generatedPaths.length &&
      members.length &&
      members.every((f) => generatedUnder(f.file))
    ) {
      return {
        ...d,
        verdict: "FALSE_POSITIVE",
        reason: "every copy is inside generated output",
      };
    }
    const pairs = [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (
          a.file === b.file ||
          generatedUnder(a.file) ||
          generatedUnder(b.file)
        )
          continue;
        const sim = Parser.codeSimilarity(
          codeAt.get(`${a.file}:${a.line}`),
          codeAt.get(`${b.file}:${b.line}`)
        );
        if (sim > 0.7) pairs.push({ a, b, sim: Math.round(sim * 100) });
      }
    }
    if (!pairs.length) {
      return {
        ...d,
        verdict: "FALSE_POSITIVE",
        reason:
          "no two members in different in-scope files reach 70% under CodeFlow's own codeSimilarity once every pair is scored",
      };
    }
    const allTest = pairs.every(
      (p) => TEST_PATH.test(p.a.file) && TEST_PATH.test(p.b.file)
    );
    return {
      ...d,
      verdict: "NEEDS_REVIEW",
      pairs,
      severity: allTest ? "low (test helpers)" : "low",
      reason: `${pairs.length} verified pair(s) above 70%`,
    };
  });

  const secVerified = !!security;
  const secById = new Map((security?.items ?? []).map((s) => [s.id, s]));
  const sec = security?.verdicts ?? [];
  const secOpen = sec.filter((s) => s.verdict !== "FALSE_POSITIVE");
  const secFP = sec.filter((s) => s.verdict === "FALSE_POSITIVE");
  const secHighs = secOpen.filter(
    (s) => (secById.get(s.id) || {}).severity === "high"
  ).length;

  const issue = (t) =>
    data.issues.find((i) => i.title.includes(t)) || { items: [] };
  const largeIn = issue("Large Files").items.filter((x) => inScope(x.file));
  const complexIn = issue("High Complexity")
    .items.filter((x) => inScope(x.file))
    .sort((a, b) => b.score - a.score);
  const coupledIn = issue("Highly Coupled").items.filter((x) =>
    inScope(x.file)
  );
  const inScopeFns = data.files
    .filter((f) => inScope(f.path))
    .reduce((n, f) => n + (f.functions || []).length, 0);

  const count = (arr, v) => arr.filter((x) => x.verdict === v).length;
  const tallies = (arr) =>
    arr.reduce((m, x) => ((m[x.verdict] = (m[x.verdict] || 0) + 1), m), {});
  const hb = Object.fromEntries(hp.breakdown.map((b) => [b.factor, b]));
  const deadConfirmed = count(dead, "CONFIRMED");
  const pen = {
    dead: Math.min(20, inScopeFns ? (deadConfirmed / inScopeFns) * 100 : 0),
    circ: circular.some((c) => c.verdict === "CONFIRMED") ? 5 : 0,
    large: largeIn.length ? 3 : 0,
    sec: secVerified
      ? Math.min(20, secHighs * 5)
      : -hb["High-severity security issues"].penalty,
  };
  const verifiedScore = Math.round(
    100 - pen.dead - pen.circ - pen.large - pen.sec
  );

  const out = [];
  const w = (s = "") => out.push(s);
  const counter = (kind) => {
    let n = 0;
    return () => `${P}-${kind}-${String(++n).padStart(3, "0")}`;
  };

  w(`# ${name} code audit, CodeFlow scan${date ? ` of ${date}` : ""}`);
  w();
  const where = inGit
    ? `branch \`${branch ?? "unknown"}\`, HEAD \`${head ?? "none"}\``
    : "not a git repository";
  const excludes = data.excludePatterns?.length
    ? `excludes: ${data.excludePatterns.join(", ")}`
    : "no excludes";
  w(
    `Repo \`${name}\`, ${where}. Scanned with the CodeFlow headless analyzer (${excludes}).`
  );
  w(
    "I then checked every in-scope finding against the code on disk. Anything CodeFlow reported that does not hold up is listed under false positives with the reason, so it can be dismissed without re-checking."
  );
  w();
  w(
    `Scope is every analyzed file that git does not ignore. ${ignored.size} of ${data.files.length} analyzed files are gitignored (local-only by design) and were not audited; they are counted at the end, not judged.`
  );
  w();
  w("## Summary");
  w();
  w(
    "| Category | Reported (all files) | In scope | Confirmed | Needs review | False positive |"
  );
  w("|---|---|---|---|---|---|");
  const row = (title, all, arr) =>
    w(
      `| ${title} | ${all} | ${arr.length} | ${count(arr, "CONFIRMED")} | ${count(arr, "NEEDS_REVIEW")} | ${count(arr, "FALSE_POSITIVE")} |`
    );
  if (secVerified) row("Security", data.securityIssues.length, sec);
  else
    w(
      `| Security | ${data.securityIssues.length} | not verified | - | - | - |`
    );
  row("Unused functions", data.deadFunctions.length, dead);
  row("Circular dependencies", issue("Circular").items.length, circular);
  row("Layer violations", data.layerViolations.length, layer);
  row("Duplicates", data.duplicates.length, dups);
  w();
  w(
    `CodeFlow gave this repo ${hp.health.score}/100 (${hp.health.grade}). Recomputing its own formula with only verified in-scope findings gives about ${verifiedScore}/100; see [Health score](#health-score).`
  );
  w();

  w("## Triage queue");
  w();
  w(
    'Everything here survived verification. Severity is my suggestion, not CodeFlow\'s. "Needs review" means the code is real but whether it is a problem is a product or ownership call.'
  );
  w();
  w("| ID | Verdict | Severity | Where | Finding | Evidence | Suggested fix |");
  w("|---|---|---|---|---|---|---|");
  for (const s of secOpen) {
    const src = secById.get(s.id) || {};
    w(
      `| ${s.id} | ${s.verdict} | ${esc(s.suggestedSeverity || src.severity)} | \`${esc(s.path)}${src.line ? `:${src.line}` : ""}\` | ${esc(s.title)}: ${esc(s.reason)} | ${esc(redact(s.evidence))} | ${esc(s.fix)} |`
    );
  }
  for (const x of notes) {
    w(
      `| ${x.id} | NEEDS_REVIEW | ${esc(x.severity)} | \`${esc(x.where)}\` | ${esc(x.finding)} | ${esc(x.evidence)} | ${esc(x.fix)} |`
    );
  }
  const circId = counter("CIRC");
  for (const c of circular.filter((c) => c.verdict === "CONFIRMED")) {
    const note =
      overrides.circularNotes?.[c.files[0]] ||
      "UNKNOWN whether evaluation order is safe";
    w(
      `| ${circId()} | CONFIRMED | low | \`${c.files.join("` and `")}\` | circular import; ${esc(note)} | ${esc(c.evidence.join("; "))} | break the cycle if either side ever needs the other at load time; not urgent |`
    );
  }
  const deadId = counter("DEAD");
  for (const d of dead.filter((d) => d.verdict !== "FALSE_POSITIVE")) {
    w(
      `| ${deadId()} | ${d.verdict} | ${d.severity ?? "low"} | \`${d.file}:${d.line}\` | \`${esc(d.name)}\` has no caller | ${esc(d.reason)} | ${esc(d.fix ?? "")} |`
    );
  }
  const dupId = counter("DUP");
  for (const d of dups.filter((d) => d.verdict === "NEEDS_REVIEW")) {
    const pairs = d.pairs ?? [];
    const ps = pairs
      .slice(0, 6)
      .map(
        (p) =>
          `\`${p.a.file}:${p.a.line}\` ~ \`${p.b.file}:${p.b.line}\` ${p.sim}%`
      )
      .join("; ");
    const more = pairs.length > 6 ? ` (+${pairs.length - 6} more)` : "";
    const pairCell = pairs.length
      ? `${pairs.length} pair(s)`
      : `${d.files.length} location(s)`;
    w(
      `| ${dupId()} | NEEDS_REVIEW | ${d.severity ?? "low"} | ${pairCell} | ${d.type} duplicate \`${esc(clip(d.name, 80))}\` | ${esc(ps || d.reason)}${more} | extract a shared helper only if the copies must change together |`
    );
  }
  w();

  w("## False positives");
  w();
  w(
    "Each row gives the reason the finding does not hold. The recurring causes, all traced to the analyzer core:"
  );
  w();
  w(
    "- Its call graph links a call to any function with the same name when only one definition exists in the scan, with no import check. That produces most unused-function and layer-violation noise."
  );
  w(
    '- `detectLayer` sends any path it does not recognise to `utils`, so "utils imports services" often just means "an unrecognised folder imports services".'
  );
  w(
    "- Security rules are line regexes, so an identifier or word that merely contains a rule's keyword can match, and TODO-style counters match inside longer words."
  );
  w(
    "- Similar-code groups share a fingerprint, but only the first two members are compared."
  );
  w();
  const fpSection = (title, rows, header, fmt) => {
    if (!rows.length) return;
    w(`### ${title} (${rows.length})`);
    w();
    w(header);
    w(header.replace(/[^|]+/g, "---"));
    rows.forEach((r) => w(fmt(r)));
    w();
  };
  fpSection(
    "Security",
    secFP,
    "| ID | Rule | Where | Why it is not an issue |",
    (s) => {
      const src = secById.get(s.id) || {};
      return `| ${s.id} | ${esc(s.title)} (${src.severity}) | \`${esc(s.path)}${src.line ? `:${src.line}` : ""}\` | ${esc(redact(s.reason))} |`;
    }
  );
  fpSection(
    "Unused functions",
    dead.filter((d) => d.verdict === "FALSE_POSITIVE"),
    "| Function | Where | Why it is used |",
    (d) => `| \`${esc(d.name)}\` | \`${d.file}:${d.line}\` | ${esc(d.reason)} |`
  );
  fpSection(
    "Circular dependencies",
    circular.filter((c) => c.verdict === "FALSE_POSITIVE"),
    "| Files | Why |",
    (c) => `| \`${c.files.join("` `")}\` | ${esc(c.reason)} |`
  );
  fpSection(
    "Layer violations",
    layer.filter((l) => l.verdict === "FALSE_POSITIVE"),
    "| From | To | Edge fn | Why |",
    (l) =>
      `| \`${l.from}\` (${l.fromLayer}) | \`${l.to}\` (${l.toLayer}) | \`${esc(l.fn)}\` | ${esc(l.reason)} |`
  );
  fpSection(
    "Duplicates",
    dups.filter((d) => d.verdict === "FALSE_POSITIVE"),
    "| Group | Type | Why |",
    (d) => `| \`${esc(clip(d.name, 100))}\` | ${d.type} | ${esc(d.reason)} |`
  );

  w("## Metrics, not defects");
  w();
  w(
    "These are size and shape signals. Nothing here is wrong on its own, so I did not give verdicts. Use them when choosing refactor targets."
  );
  w();
  w(
    `Coupling (${coupledIn.length} in-scope files flagged "Highly Coupled") counts call edges, and those edges include the bare-name matches above, so the real coupling of each file is UNKNOWN and probably lower.`
  );
  w();
  w(`### Large files, in scope (${largeIn.length})`);
  w();
  w("| File | Functions | Lines |");
  w("|---|---|---|");
  largeIn.forEach((x) => w(`| \`${x.file}\` | ${x.fns} | ${x.lines} |`));
  w();
  w(`### High complexity files, in scope (${complexIn.length})`);
  w();
  w("| File | Score | Lines |");
  w("|---|---|---|");
  complexIn.forEach((x) => w(`| \`${x.file}\` | ${x.score} | ${x.lines} |`));
  w();
  if (data.patterns.some((p) => p.isAnti && p.name === "VBA God Module")) {
    w(
      'The "VBA God Module" anti-pattern in the raw report fires on any code file with more than 20 functions regardless of language, so treat it as a duplicate of the large-file list.'
    );
    w();
  }

  w("## Health score");
  w();
  w("| Factor | CodeFlow (all files) | Verified, in scope |");
  w("|---|---|---|");
  const secCell = secVerified
    ? `${minus(pen.sec)} (${secHighs} in-scope high(s) survived verification)`
    : `${minus(pen.sec)} (not verified, taken from CodeFlow)`;
  w(
    `| Unused functions | ${hb["Dead code"].penalty.toFixed(1)} (${hb["Dead code"].measured}) | ${minus(pen.dead, 1)} (${deadConfirmed} of ${inScopeFns} functions) |`
  );
  w(
    `| Circular dependencies | ${hb["Circular dependency issues"].penalty} | ${minus(pen.circ)} |`
  );
  w(
    `| Large files | ${hb["Large-file issues"].penalty} | ${minus(pen.large)} |`
  );
  w(
    `| Coupling | ${hb["Average coupling"].penalty} (${hb["Average coupling"].measured}) | 0 at the reported value; true value UNKNOWN |`
  );
  w(
    `| High-severity security | ${hb["High-severity security issues"].penalty} (${hb["High-severity security issues"].measured} highs) | ${secCell} |`
  );
  w(`| Score | ${hp.health.score} | about ${verifiedScore} |`);
  w();
  w(
    "The verified column only covers in-scope files. Highs inside gitignored paths were not audited, so they are left out rather than cleared."
  );
  w();

  w("## Out of scope");
  w();
  const ignDirs = {};
  ignored.forEach((p) => {
    const k = p
      .split("/")
      .slice(0, p.startsWith(".") ? 1 : 2)
      .join("/");
    ignDirs[k] = (ignDirs[k] || 0) + 1;
  });
  if (ignored.size) {
    w(
      `${ignored.size} analyzed files matched \`.gitignore\` (from \`git check-ignore\`). They are local-only by design. I did not open, judge or touch them. Largest groups:`
    );
    w();
    w("| Path prefix | Files |");
    w("|---|---|");
    Object.entries(ignDirs)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .forEach(([k, v]) => w(`| \`${k}\` | ${v} |`));
  } else {
    w("No analyzed file matched `.gitignore`.");
  }
  w();
  const oversized = data.files.filter(
    (f) =>
      f.parserProvenance === "skipped:size-limit" ||
      f.analysisSkipped === "oversized"
  );
  if (oversized.length) {
    const mb = Parser.maxAnalyzableFileBytes / 1024 / 1024;
    const listed =
      oversized.length <= 20
        ? `: ${oversized.map((f) => `\`${f.path}\``).join(", ")}`
        : "";
    w(
      `${oversized.length} more files were over CodeFlow's ${mb} MB limit and never parsed${listed}.`
    );
    w();
  }

  w("## Unknowns");
  w();
  if (hotspots) {
    w(
      `- Churn comes from git history since ${hotspots.since}, not from CodeFlow, whose headless churn field is always 0.`
    );
  } else {
    w(
      "- Git churn is not available in headless mode and no hotspot data was supplied. UNKNOWN."
    );
  }
  w("- Real coupling per file is UNKNOWN (see Metrics).");
  w(
    "- Gitignored files were not audited, so any issue inside them is UNKNOWN."
  );
  w(
    "- Duplicate pairs were scored with CodeFlow's own similarity function, which compares token shape, not behaviour. Whether a pair should be merged is a judgement call."
  );
  if (!secVerified)
    w(
      "- Security findings were not verified, so how many are real is UNKNOWN."
    );
  for (const x of notes.filter((n) => n.unknown))
    w(`- ${x.id}: ${x.unknown}. UNKNOWN.`);
  w();

  w("## How this was produced");
  w();
  w("- Raw scan and full untruncated render: `analyzeProject`.");
  w(
    "- Structural: `verifyFindings` runs `git grep` on unused names, resolves real import statements (relative, path alias, workspace package, Python dotted) for layer edges, confirms both import lines for cycles, and scores duplicates."
  );
  w(
    secVerified
      ? "- Security: every in-scope item was read in context and given a verdict with file:line evidence."
      : "- Security: no verdicts were supplied, so the CodeFlow findings are reported as raw counts only."
  );
  const handCount =
    Object.keys(overrides.dead ?? {}).length +
    Object.keys(overrides.layer ?? {}).length;
  w(
    `- This document: \`renderAudit\`, which applies ${handCount} hand-checked override(s) and ${notes.length} note(s) it was given, and rescores duplicates pairwise.`
  );
  w();

  const markdown = sanitize(out.join("\n"));
  if (outPath) {
    mkdirSync(dirname(resolve(outPath)), { recursive: true });
    writeFileSync(outPath, markdown);
  }
  return {
    markdown,
    outPath: outPath ?? null,
    verifiedScore,
    tallies: {
      sec: tallies(sec),
      dead: tallies(dead),
      circular: tallies(circular),
      layer: tallies(layer),
      dups: tallies(dups),
    },
  };
}
