import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeProject,
  buildHotspots,
  parseJsonc,
  renderAudit,
  renderReport,
  verifyFindings,
} from "../src/codeflow/headless/index.mjs";

const require = createRequire(import.meta.url);
const scratchDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function put(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function git(root, ...args) {
  return execFileSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Fixture Author",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8" }
  );
}

function commit(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
}

const MATH = `export function add(a: number, b: number) {
  return a + b;
}

function unusedHelper(x: number) {
  return x * 2;
}

function registered(x: number) {
  return x - 1;
}
`;

const USER_V1 = `import { add } from "@/lib/math";

export function createUser(name: string, age: number) {
  return { name, age: add(age, 1) };
}
`;

const USER_V2 = `import { add } from "@/lib/math";

export function createUser(name: string, age: number) {
  if (!name) {
    throw new Error("name required");
  }
  for (let i = 0; i < age; i++) {
    if (i % 2 === 0 && name.length > 3) {
      age = add(age, i);
    } else if (i > 10 || name === "x") {
      age = add(age, 1);
    }
  }
  return { name, age: add(age, 1) };
}
`;

const USER_V3 = `${USER_V2}
export function describeUser(name: string) {
  switch (name) {
    case "a":
      return "first";
    case "b":
      return "second";
    default:
      return name ? "other" : "none";
  }
}
`;

function buildFixtureRepo() {
  const root = tempDir("codeflow-headless-test-");
  git(root, "init", "-q");
  put(
    root,
    "tsconfig.json",
    `{
  // comments and trailing commas are legal in tsconfig
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./*"], "@util/*": ["lib/*"], },
  },
}
`
  );
  put(root, ".gitignore", "local/\n.codeflow/\n");
  put(root, "lib/math.ts", MATH);
  put(root, "services/user.ts", USER_V1);
  put(
    root,
    "lib/format.ts",
    `import { createUser } from "@/services/user";

export function formatUser(name: string) {
  return createUser(name, 1);
}
`
  );
  put(
    root,
    "ui/page.ts",
    `import { createUser } from "@/services/user";
import { add } from "@util/math";

export function renderPage(name: string) {
  return createUser(name, add(1, 2));
}
`
  );
  put(
    root,
    "services/cycle-a.ts",
    `import { fromB } from "@/services/cycle-b";

export function fromA() {
  return fromB();
}
`
  );
  put(
    root,
    "services/cycle-b.ts",
    `import { fromA } from "@/services/cycle-a";

export function fromB() {
  return fromA();
}
`
  );
  put(root, "config/hooks.json", '{ "handler": "registered" }\n');
  commit(root, "initial");

  put(root, "services/user.ts", USER_V2);
  commit(root, "validate user input");
  put(root, "services/user.ts", USER_V3);
  commit(root, "describe user");

  put(
    root,
    "local/scratch.ts",
    "export function scratchOnly() { return 1; }\n"
  );
  return root;
}

let repo;
let outDir;
let result;

before(async () => {
  repo = buildFixtureRepo();
  outDir = tempDir("codeflow-headless-out-");
  result = await analyzeProject({
    root: repo,
    outDir,
    label: "fixture",
    churnSince: "30 days ago",
  });
});

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const edge = (data, source, target) =>
  data.connections.some(
    (c) =>
      (c.source.id ?? c.source) === source &&
      (c.target.id ?? c.target) === target
  );

test("parseJsonc reads comments and trailing commas without touching strings", () => {
  const parsed = parseJsonc(
    '{ // note\n "a": "x // not a comment", /* b */ "b": [1, 2,], }'
  );
  assert.deepEqual(parsed, { a: "x // not a comment", b: [1, 2] });
});

test("alias imports are rewritten so they become connections", () => {
  const { data } = result.envelope;
  assert.equal(result.rewrittenAliasImports, 6);
  assert.ok(edge(data, "lib/math.ts", "services/user.ts"));
  assert.ok(edge(data, "services/user.ts", "ui/page.ts"));
  assert.ok(edge(data, "lib/math.ts", "ui/page.ts"));
  assert.ok(result.connections > 0);
});

test("the raw tree resolves fewer connections than the rewritten one", async () => {
  const { analyze } = require("../src/codeflow/lib/analysis.js");
  const raw = await analyze({ repoRoot: repo });
  assert.ok(
    raw.data.connections.length < result.envelope.data.connections.length,
    `raw ${raw.data.connections.length} vs rewritten ${result.envelope.data.connections.length}`
  );
});

test("the analyzed project is left untouched and only tracked files are scanned", () => {
  assert.match(
    readFileSync(join(repo, "ui/page.ts"), "utf8"),
    /@\/services\/user/
  );
  const paths = result.envelope.data.files.map((f) => f.path);
  assert.ok(paths.includes("services/user.ts"));
  assert.ok(!paths.some((p) => p.startsWith("local/")));
  assert.equal(result.trackedOnly, true);
});

test("hotspot rows carry churn from git history", () => {
  const { hotspots } = result;
  assert.ok(hotspots.rows.length > 0);
  for (const row of hotspots.rows) assert.ok(row.churn > 0, row.path);
  const top = hotspots.rows[0];
  assert.equal(top.path, "services/user.ts");
  assert.equal(top.churn, 3);
  assert.equal(top.authors, 1);
  assert.equal(top.hotspot, top.churn * top.complexity);
  assert.match(hotspots.head, /^[0-9a-f]{7,}$/);
});

test("buildHotspots drops files git ignores now", async () => {
  const wide = await analyzeProject({
    root: repo,
    outDir: tempDir("codeflow-headless-out-"),
    label: "wide",
    trackedOnly: false,
  });
  const paths = wide.envelope.data.files.map((f) => f.path);
  assert.ok(paths.includes("local/scratch.ts"));
  const rebuilt = buildHotspots(wide.envelope.data, repo, "30 days ago");
  assert.ok(rebuilt.ignoredNow >= 1);
  assert.ok(!rebuilt.rows.some((r) => r.path.startsWith("local/")));
  assert.ok(rebuilt.rows.some((r) => r.path === "services/user.ts"));
});

test("report files exist and are complete", () => {
  for (const key of ["envelope", "hotspots", "report", "blast", "health"]) {
    assert.ok(existsSync(result.outputs[key]), key);
  }
  const md = readFileSync(result.outputs.report, "utf8");
  assert.match(md, /^# CodeFlow full analysis: fixture/);
  assert.match(md, /## Hotspots/);
  assert.match(md, /## Blast radius, every file/);
  assert.match(md, /## Function statistics/);
  assert.match(md, /6 alias imports rewritten/);
  assert.ok(md.includes("`services/user.ts`"));

  const blast = JSON.parse(readFileSync(result.outputs.blast, "utf8"));
  const math = blast.find((b) => b.path === "lib/math.ts");
  assert.ok(math.count >= 2);
  const health = JSON.parse(readFileSync(result.outputs.health, "utf8"));
  assert.equal(health.health.score, result.score);
  assert.equal(health.breakdown.length, 5);
});

test("renderReport works without hotspots and writes under the given base", () => {
  const base = join(outDir, "plain");
  const rendered = renderReport({
    envelope: result.envelope,
    label: "plain",
    base,
  });
  assert.ok(existsSync(rendered.files.report));
  assert.doesNotMatch(
    readFileSync(rendered.files.report, "utf8"),
    /## Hotspots/
  );
});

test("aliases override works on a project outside git", async () => {
  const dir = tempDir("codeflow-headless-plain-");
  put(dir, "app/core/engine.ts", "export function run() {\n  return 1;\n}\n");
  put(
    dir,
    "app/main.ts",
    'import { run } from "~/core/engine";\n\nexport function main() {\n  return run();\n}\n'
  );
  const plain = await analyzeProject({
    root: dir,
    outDir: join(dir, "reports"),
    aliases: { "~/": "app/" },
  });
  assert.equal(plain.trackedOnly, false);
  assert.equal(plain.rewrittenAliasImports, 1);
  assert.equal(plain.hotspots, null);
  assert.ok(edge(plain.envelope.data, "app/core/engine.ts", "app/main.ts"));
  assert.ok(
    existsSync(join(dir, "reports", `${dir.split("/").pop()}.full-report.md`))
  );
});

test("verify returns verdicts for dead functions, layers and cycles", () => {
  const verdicts = verifyFindings({ root: repo, envelope: result.envelope });
  assert.ok(Array.isArray(verdicts.ignoredPaths));

  const byName = Object.fromEntries(verdicts.dead.map((d) => [d.name, d]));
  assert.equal(byName.unusedHelper?.verdict, "CONFIRMED");
  assert.equal(byName.registered?.verdict, "FALSE_POSITIVE");
  assert.match(byName.registered.reason, /reference/);
  assert.equal(byName.registered.evidence[0].file, "config/hooks.json");

  const layer = verdicts.layer.find((l) => l.from === "lib/format.ts");
  assert.ok(layer, "format.ts importing a service is a layer violation");
  assert.equal(layer.verdict, "NEEDS_REVIEW");
  assert.match(layer.reason, /@\/services\/user/);

  assert.equal(verdicts.circular.length, 1);
  assert.equal(verdicts.circular[0].verdict, "CONFIRMED");
  assert.ok(verdicts.circular[0].evidence.length === 2);
  assert.ok(verdicts.tally.dead.CONFIRMED >= 1);
});

test("verify honours a caller-supplied ignored path list", () => {
  const verdicts = verifyFindings({
    root: repo,
    envelope: result.envelope,
    ignoredPaths: ["lib/math.ts"],
  });
  assert.ok(!verdicts.dead.some((d) => d.file === "lib/math.ts"));
});

test("audit renders verdicts, overrides, notes and security rows", () => {
  const verdicts = verifyFindings({ root: repo, envelope: result.envelope });
  const outPath = join(outDir, "audits", "fixture-audit.md");
  const audit = renderAudit({
    root: repo,
    envelope: result.envelope,
    verdicts,
    health: result.health,
    hotspots: result.hotspots,
    label: "fixture",
    outPath,
    overrides: {
      dead: {
        "lib/math.ts:unusedHelper": {
          verdict: "CONFIRMED",
          severity: "medium",
          reason: "checked by hand, nothing calls it",
          fix: "delete it",
        },
      },
      circularNotes: {
        "services/cycle-a.ts":
          "both calls sit inside function bodies, so load order is safe",
      },
    },
    notes: [
      {
        id: "F-NOTE-001",
        severity: "low",
        where: "ui/page.ts:1",
        finding: "sample note \u2014 with a dash",
        evidence: "page.ts:1",
        fix: "none",
        unknown: "depends on a runtime setting that was not checked",
      },
    ],
    security: {
      items: [{ id: "F-SEC-001", severity: "high", line: 3 }],
      verdicts: [
        {
          id: "F-SEC-001",
          verdict: "CONFIRMED",
          path: "ui/page.ts",
          title: "sample rule",
          reason: "read in context",
          evidence: "page.ts:3 db://user:secret@host/x",
          fix: "rotate",
        },
      ],
    },
  });

  assert.ok(existsSync(outPath));
  assert.equal(readFileSync(outPath, "utf8"), audit.markdown);
  assert.match(
    audit.markdown,
    /^# fixture code audit, CodeFlow scan of \d{4}-\d{2}-\d{2}/
  );
  assert.match(
    audit.markdown,
    /F-DEAD-001 \| CONFIRMED \| medium \| `lib\/math\.ts:\d+` \| `unusedHelper`/
  );
  assert.match(audit.markdown, /F-CIRC-001 .*load order is safe/);
  assert.match(audit.markdown, /F-NOTE-001/);
  assert.match(audit.markdown, /db:\/\/user:\*\*\*@host/);
  assert.doesNotMatch(audit.markdown, /secret@host/);
  assert.match(audit.markdown, /F-NOTE-001: depends on a runtime setting/);
  assert.match(audit.markdown, /## False positives/);
  assert.match(audit.markdown, /`registered`/);
  assert.equal(typeof audit.verifiedScore, "number");
  assert.doesNotMatch(audit.markdown, /[\u2013\u2014]/);
});

test("audit without security verdicts says so instead of inventing counts", () => {
  const verdicts = verifyFindings({ root: repo, envelope: result.envelope });
  const audit = renderAudit({
    root: repo,
    envelope: result.envelope,
    verdicts,
    label: "fixture",
  });
  assert.match(audit.markdown, /\| Security \| \d+ \| not verified/);
  assert.match(audit.markdown, /Security findings were not verified/);
});

test("the module carries no hardcoded absolute paths", () => {
  const dir = join(
    dirname(fileURLToPath(import.meta.url)),
    "../src/codeflow/headless"
  );
  for (const file of [
    "analyze",
    "hotspots",
    "report",
    "verify",
    "audit",
    "index",
  ]) {
    const text = readFileSync(join(dir, `${file}.mjs`), "utf8");
    assert.doesNotMatch(text, /\/Users\/|\/home\/|[A-Z]:\\/, file);
  }
});
