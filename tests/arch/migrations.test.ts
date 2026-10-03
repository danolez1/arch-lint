import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfigs, resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import { findRule } from "../../src/arch/registry";
import {
  RULES,
  checkJournal,
  checkPushedJournals,
  gitJournalReader,
  maskSql,
  releasedImmutableRule,
  runJournalCheck,
  type JournalEntry,
  type PushCheckDeps,
} from "../../src/arch/rules/migrations";
import { runRules } from "../../src/arch/run";
import type { Config } from "../../src/arch/types";
import { checkProject, type CheckOptions } from "./helpers";

const TX = "migration-no-tx-control";
const PRIV = "migration-no-default-privileges-for-role";
const ORDER = "migration-journal-order";
const RELEASED = "migration-released-immutable";
const PUSH = "no-drizzle-push";

const DIR = "packages/db/drizzle";
const NEW = `${DIR}/0099_new.sql`;
const JOURNAL = `${DIR}/meta/_journal.json`;
const nested: Config = { migrations: { dir: DIR, journal: JOURNAL } };

const e = (idx: number, when: number, tag = `t${idx}`): JournalEntry => ({
  idx,
  when,
  tag,
});
const journalText = (entries: JournalEntry[]) =>
  JSON.stringify({ version: "7", entries }, null, 2);

async function sqlRule(
  ruleId: string,
  sql: string,
  path = NEW,
  opts: CheckOptions = {}
) {
  return checkProject(ruleId, { [path]: sql }, { config: nested, ...opts });
}

async function sqlRules(
  sql: string,
  path = NEW,
  opts: { tx?: Record<string, unknown> } = {}
) {
  const tx = await sqlRule(TX, sql, path, { options: opts.tx });
  const priv = await sqlRule(PRIV, sql, path);
  return [...tx, ...priv].map((v) => v.rule);
}

function captureStderr<T>(
  run: () => Promise<T>
): Promise<{ result: T; written: string }> {
  const original = process.stderr.write;
  let written = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  return run()
    .then((result) => ({ result, written }))
    .finally(() => {
      process.stderr.write = original;
    });
}

test("all five rules are registered under their canonical ids", () => {
  const ids = RULES.map((r) => r.id).sort();
  assert.deepEqual(ids, [ORDER, PRIV, PUSH, RELEASED, TX].sort());
  assert.ok(RULES.every((r) => r.kind === "project"));
  assert.ok(ids.every((id) => findRule(id)));
});

test("tx control: flags top-level BEGIN; and COMMIT; with line numbers", async () => {
  const v = await sqlRule(TX, "BEGIN;\nCREATE TABLE t (id int);\ncommit;\n");
  assert.deepEqual(
    v.map((x) => [x.rule, x.line]),
    [
      [TX, 1],
      [TX, 3],
    ]
  );
  assert.equal(v[0]?.file, NEW);
});

test("tx control: flags ROLLBACK, END, START TRANSACTION and COMMIT AND CHAIN", async () => {
  const v = await sqlRule(
    TX,
    "START TRANSACTION;\nROLLBACK;\nEND;\nCOMMIT AND NO CHAIN;\n"
  );
  assert.equal(v.length, 4);
});

test("tx control: flags back-to-back statements and BEGIN TRANSACTION", async () => {
  assert.equal((await sqlRule(TX, "BEGIN TRANSACTION;COMMIT WORK;")).length, 2);
});

test("tx control: ignores comments, strings and plpgsql DO blocks", async () => {
  const sql = [
    "-- BEGIN;",
    "/* COMMIT; */",
    "SELECT 'BEGIN;';",
    "DO $$ BEGIN RAISE NOTICE 'x'; END $$;",
    "DO $body$\nBEGIN\n  COMMIT;\nEND\n$body$;",
  ].join("\n");
  assert.deepEqual(await sqlRules(sql), []);
});

test("tx control: masking keeps comments and strings from matching, lines stay put", async () => {
  const sql = "-- BEGIN;\nSELECT 'COMMIT;';";
  assert.equal(maskSql(sql).length, sql.length);
  assert.deepEqual(
    await sqlRule(TX, sql, "drizzle/0001.sql", { config: {} }),
    []
  );
  const v = await sqlRule(
    TX,
    "BEGIN;\nCREATE TABLE t (id int);\nCOMMIT;\n",
    "drizzle/0001.sql",
    { config: {} }
  );
  assert.deepEqual(
    v.map((x) => x.line),
    [1, 3]
  );
});

test("tx control: grandfathered file names are skipped, other files are not", async () => {
  const grandfathered = [
    "0004_enable_rls.sql",
    "0008_grants_restrict_grantee_write.sql",
    "0009_rls_bypass_via_role.sql",
    "0047_patient_demographics_rls.sql",
    "0048_backfill_persons.sql",
    "0050_backfill_biological_sex.sql",
    "0052_mpi_rls.sql",
  ];
  assert.deepEqual(
    await sqlRules("BEGIN;\nCOMMIT;", `${DIR}/0004_enable_rls.sql`, {
      tx: { grandfathered },
    }),
    []
  );
  assert.equal(
    (
      await sqlRules("BEGIN;\nCOMMIT;", `${DIR}/0053_other.sql`, {
        tx: { grandfathered },
      })
    ).length,
    2
  );
});

test("tx control: without the option nothing is grandfathered", async () => {
  assert.equal(
    (await sqlRules("BEGIN;\nCOMMIT;", `${DIR}/0004_enable_rls.sql`)).length,
    2
  );
});

test("tx control: default privileges FOR ROLE is still flagged in a grandfathered file", async () => {
  const rules = await sqlRules(
    "ALTER DEFAULT PRIVILEGES FOR ROLE x GRANT SELECT ON TABLES TO r;",
    `${DIR}/0004_enable_rls.sql`,
    {
      tx: { grandfathered: ["0004_enable_rls.sql"] },
    }
  );
  assert.deepEqual(rules, [PRIV]);
});

test("tx control: only files directly inside the migration dir are read", async () => {
  const v = await checkProject(
    TX,
    {
      [`${DIR}/meta/0001.sql`]: "BEGIN;",
      [`${DIR}/0001.txt`]: "BEGIN;",
      "other/0001.sql": "BEGIN;",
      [`${DIR}/0002.sql`]: "BEGIN;",
    },
    { config: nested }
  );
  assert.deepEqual(
    v.map((x) => x.file),
    [`${DIR}/0002.sql`]
  );
});

test("tx control: default migration dir is drizzle and the message option is honored", async () => {
  const v = await checkProject(
    TX,
    { "drizzle/0001.sql": "COMMIT;" },
    { options: { message: "no tx here" } }
  );
  assert.deepEqual(
    v.map((x) => [x.file, x.message]),
    [["drizzle/0001.sql", "no tx here"]]
  );
});

test("tx control: exempt files from the config apply to project rules", async () => {
  const v = await checkProject(
    TX,
    { "drizzle/0001.sql": "COMMIT;" },
    { settings: { exempt: { files: ["drizzle/0001.sql"] } } }
  );
  assert.deepEqual(v, []);
});

test("default privileges: flags FOR ROLE and FOR USER", async () => {
  assert.deepEqual(
    await sqlRules(
      "ALTER DEFAULT PRIVILEGES FOR ROLE app IN SCHEMA public GRANT SELECT ON TABLES TO r;"
    ),
    [PRIV]
  );
  assert.equal(
    (
      await sqlRules(
        "alter default privileges\n  for user owner grant usage on sequences to r;"
      )
    ).length,
    1
  );
});

test("default privileges: reports the line of the statement", async () => {
  const v = await sqlRule(
    PRIV,
    "SELECT 1;\n\nALTER DEFAULT PRIVILEGES FOR ROLE x GRANT SELECT ON TABLES TO r;"
  );
  assert.deepEqual(
    v.map((x) => x.line),
    [3]
  );
});

test("default privileges: allows the statement without FOR ROLE", async () => {
  assert.deepEqual(
    await sqlRules(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO app_role;"
    ),
    []
  );
});

test("maskSql preserves length and newlines", () => {
  const sql = "a -- c\n'x'\n$$y\n$$";
  const masked = maskSql(sql);
  assert.equal(masked.length, sql.length);
  assert.equal(masked.split("\n").length, sql.split("\n").length);
});

test("checkJournal: passes when base entries are unchanged and new ones are appended", () => {
  assert.deepEqual(
    checkJournal([e(0, 1), e(1, 2), e(2, 3)], [e(0, 1), e(1, 2)]),
    []
  );
});

test("checkJournal: flags changed tag, changed when and removed entries", () => {
  const v = checkJournal(
    [e(0, 1, "renamed"), e(1, 5)],
    [e(0, 1), e(1, 2), e(2, 3)]
  );
  assert.equal(v.length, 3);
  assert.ok(v.every((x) => x.rule === RELEASED));
});

test("checkJournal: flags non-increasing idx and when under the ordering rule", () => {
  const v = checkJournal([e(0, 5), e(0, 6), e(1, 6)], null);
  assert.equal(v.length, 2);
  assert.ok(v.every((x) => x.rule === ORDER));
});

test("checkJournal: skips base comparison when base is unavailable", () => {
  assert.deepEqual(checkJournal([e(0, 1)], null), []);
});

test("checkJournal: released and order checks together, messages name the entries", () => {
  const base = [e(0, 1, "0000_a"), e(1, 2, "0001_b")];
  assert.equal(checkJournal([...base, e(2, 3, "0002_c")], base).length, 0);
  const removed = checkJournal([base[0] as JournalEntry], base);
  assert.deepEqual(
    removed.map((v) => v.message),
    ["Released migration 0001_b (idx 1) was removed from the journal."]
  );
  const renamed = checkJournal(
    [base[0] as JournalEntry, e(1, 2, "0001_renamed")],
    base
  );
  assert.deepEqual(
    renamed.map((v) => v.message),
    [
      "Released migration idx 1 changed: 0001_b@2 is now 0001_renamed@2. Add a new migration instead.",
    ]
  );
  const order = checkJournal([e(0, 5), e(1, 4)], null);
  assert.deepEqual(
    order.map((v) => v.message),
    ["Journal when not strictly increasing at t1 (5 then 4)."]
  );
});

test("checkJournal: violations point at the journal path, default and custom", () => {
  assert.equal(
    checkJournal([e(1, 1), e(0, 2)], null)[0]?.file,
    "drizzle/meta/_journal.json"
  );
  assert.equal(
    checkJournal([e(1, 1), e(0, 2)], null, { journalPath: JOURNAL })[0]?.file,
    JOURNAL
  );
  assert.equal(checkJournal([e(1, 1), e(0, 2)], null)[0]?.line, 0);
});

test("checkJournal: per-entry reports one violation per bad pair, per-field reports both fields", () => {
  const current = [e(0, 5), e(1, 4)];
  assert.equal(
    checkJournal(current, null, { orderReport: "per-entry" }).length,
    1
  );
  assert.deepEqual(
    checkJournal([e(1, 5), e(0, 4)], null, { orderReport: "per-entry" }).map(
      (v) => v.message
    ),
    ["Journal not strictly increasing at t0"]
  );
  assert.equal(
    checkJournal([e(1, 5), e(0, 4)], null, { orderReport: "per-field" }).length,
    2
  );
  assert.equal(checkJournal([e(1, 5), e(0, 4)], null).length, 2);
});

test("journal order rule: reads the configured journal from the working tree", async () => {
  const files = { [JOURNAL]: journalText([e(0, 5), e(0, 6), e(1, 6)]) };
  const v = await checkProject(ORDER, files, { config: nested });
  assert.deepEqual(
    v.map((x) => [x.file, x.line, x.rule]),
    [
      [JOURNAL, 0, ORDER],
      [JOURNAL, 0, ORDER],
    ]
  );
});

test("journal order rule: per-entry report option and message option", async () => {
  const files = { [JOURNAL]: journalText([e(1, 5), e(0, 4)]) };
  const perEntry = await checkProject(ORDER, files, {
    config: nested,
    options: { report: "per-entry" },
  });
  assert.equal(perEntry.length, 1);
  const custom = await checkProject(ORDER, files, {
    config: nested,
    options: { message: "fix the journal" },
  });
  assert.ok(custom.every((x) => x.message === "fix the journal"));
});

test("journal order rule: workingTree false switches the normal-run check off", async () => {
  const files = { [JOURNAL]: journalText([e(1, 5), e(0, 4)]) };
  assert.deepEqual(
    await checkProject(ORDER, files, {
      config: nested,
      options: { workingTree: false },
    }),
    []
  );
});

test("journal order rule: a clean, missing or malformed journal", async () => {
  assert.deepEqual(
    await checkProject(
      ORDER,
      { [JOURNAL]: journalText([e(0, 1), e(1, 2)]) },
      { config: nested }
    ),
    []
  );
  assert.deepEqual(
    await checkProject(ORDER, { "a.txt": "x" }, { config: nested }),
    []
  );
  const bad = await checkProject(
    ORDER,
    { [JOURNAL]: "{not json" },
    { config: nested }
  );
  assert.deepEqual(
    bad.map((x) => [x.file, x.rule]),
    [[JOURNAL, ORDER]]
  );
  const noEntries = await checkProject(
    ORDER,
    { [JOURNAL]: "{}" },
    { config: nested }
  );
  assert.equal(noEntries.length, 1);
});

test("journal order rule: the default journal path is drizzle/meta/_journal.json", async () => {
  const v = await checkProject(ORDER, {
    "drizzle/meta/_journal.json": journalText([e(1, 1), e(1, 2)]),
  });
  assert.deepEqual(
    v.map((x) => x.file),
    ["drizzle/meta/_journal.json"]
  );
});

async function runReleased(
  workingTree: unknown,
  reader: Parameters<typeof releasedImmutableRule>[0],
  files: Record<string, string>
) {
  const config = resolveConfig(
    mergeConfigs(nested, {
      rules: { [RELEASED]: { level: "error", options: { workingTree } } },
    })
  );
  return runRules({
    root: "/virtual",
    config,
    fs: memoryFileSystem(files),
    rules: [releasedImmutableRule(reader)],
  });
}

test("released rule: compares the working tree journal with the base ref when workingTree is set", async () => {
  const seen: string[] = [];
  const reader = (root: string, ref: string, journal: string) => {
    seen.push(`${root} ${ref} ${journal}`);
    return [e(0, 1), e(1, 2)];
  };
  const { violations } = await runReleased(true, reader, {
    [JOURNAL]: journalText([e(0, 1, "renamed")]),
  });
  assert.deepEqual(seen, [`/virtual origin/main ${JOURNAL}`]);
  assert.deepEqual(
    violations.map((v) => [v.rule, v.file]),
    [
      [RELEASED, JOURNAL],
      [RELEASED, JOURNAL],
    ]
  );
});

test("released rule: does nothing in a normal run unless workingTree is set", async () => {
  let calls = 0;
  const reader = () => {
    calls++;
    return [e(0, 1)];
  };
  const files = { [JOURNAL]: journalText([]) };
  assert.deepEqual(
    (await runReleased(undefined, reader, files)).violations,
    []
  );
  assert.deepEqual((await runReleased(false, reader, files)).violations, []);
  assert.equal(calls, 0);
});

test("released rule: an unreadable base ref is skipped with a warning", async () => {
  const { result, written } = await captureStderr(() =>
    runReleased(true, () => null, { [JOURNAL]: journalText([e(0, 1)]) })
  );
  assert.deepEqual(result.violations, []);
  assert.equal(
    written,
    `${RELEASED} skipped: cannot read origin/main:${JOURNAL}\n`
  );
});

test("released rule: a missing working tree journal is skipped without reading git", async () => {
  let calls = 0;
  const { violations } = await runReleased(true, () => (calls++, []), {
    "a.txt": "x",
  });
  assert.deepEqual(violations, []);
  assert.equal(calls, 0);
});

test("released rule: honors configured base ref", async () => {
  const config = resolveConfig(
    mergeConfigs(
      { migrations: { dir: DIR, journal: JOURNAL, baseRef: "origin/release" } },
      {
        rules: {
          [RELEASED]: { level: "error", options: { workingTree: true } },
        },
      }
    )
  );
  const refs: string[] = [];
  await runRules({
    root: "/virtual",
    config,
    fs: memoryFileSystem({ [JOURNAL]: journalText([e(0, 1)]) }),
    rules: [releasedImmutableRule((_r, ref) => (refs.push(ref), [e(0, 1)]))],
  });
  assert.deepEqual(refs, ["origin/release"]);
});

test("the registered released rule is a no-op without git state and workingTree", async () => {
  const v = await checkProject(
    RELEASED,
    { [JOURNAL]: journalText([e(0, 1)]) },
    { config: nested }
  );
  assert.deepEqual(v, []);
});

test("gitJournalReader returns null when git cannot read the ref", () => {
  assert.equal(
    gitJournalReader(
      "/virtual-root-that-does-not-exist",
      "origin/main",
      JOURNAL
    ),
    null
  );
});

test("no-drizzle-push: flags scripts that run drizzle-kit push, with the script's line", async () => {
  const pkg = [
    "{",
    '  "scripts": {',
    '    "build": "next build",',
    '    "db:generate": "drizzle-kit generate",',
    '    "db:push": "drizzle-kit push",',
    '    "db:force": "bunx drizzle-kit   push --force"',
    "  }",
    "}",
  ].join("\n");
  const v = await checkProject(PUSH, { "package.json": pkg });
  assert.deepEqual(
    v.map((x) => [x.file, x.line, x.rule]),
    [
      ["package.json", 5, PUSH],
      ["package.json", 6, PUSH],
    ]
  );
  assert.equal(
    v[0]?.message,
    'Script "db:push" runs drizzle-kit push; schema changes go through db:generate and db:migrate'
  );
});

test("no-drizzle-push: clean scripts, a missing package.json and invalid JSON report nothing", async () => {
  assert.deepEqual(
    await checkProject(PUSH, {
      "package.json": '{"scripts":{"a":"drizzle-kit pushy"}}',
    }),
    []
  );
  assert.deepEqual(
    await checkProject(PUSH, { "package.json": '{"name":"x"}' }),
    []
  );
  assert.deepEqual(await checkProject(PUSH, { "readme.md": "x" }), []);
  assert.deepEqual(await checkProject(PUSH, { "package.json": "{oops" }), []);
});

test("no-drizzle-push: files option reads other package files, pattern option changes the match", async () => {
  const files = {
    "package.json": '{"scripts":{"a":"drizzle-kit push"}}',
    "packages/db/package.json":
      '{"scripts":{"push":"drizzle-kit push","sync":"prisma db push"}}',
  };
  const both = await checkProject(PUSH, files, {
    options: { files: ["package.json", "packages/db/package.json"] },
  });
  assert.deepEqual(
    both.map((v) => v.file),
    ["package.json", "packages/db/package.json"]
  );
  const custom = await checkProject(PUSH, files, {
    options: {
      files: ["packages/db/package.json"],
      pattern: "prisma\\s+db\\s+push",
    },
  });
  assert.deepEqual(
    custom.map((v) => v.message.includes('"sync"')),
    [true]
  );
  const custom2 = await checkProject(PUSH, files, {
    options: { message: "use migrations" },
  });
  assert.deepEqual(
    custom2.map((v) => v.message),
    ["use migrations"]
  );
});

const MAIN = "refs/heads/main";
const SHA = "1".repeat(40);
const OTHER_SHA = "2".repeat(40);
const refLine = (sha: string, remote = MAIN) =>
  `refs/heads/work ${sha} ${remote} ${"0".repeat(40)}`;

interface PushRun {
  code: number;
  stderr: string;
  reads: string[];
}

function pushRun(
  pushed: string | null,
  journals: Record<string, JournalEntry[] | null>,
  config: Config = {},
  rules: Record<string, unknown> = {}
): PushRun {
  const resolved = resolveConfig(
    mergeConfigs(config, { rules: rules as Config["rules"] })
  );
  const reads: string[] = [];
  let stderr = "";
  const deps: PushCheckDeps = {
    readJournal: (ref) => (reads.push(ref), journals[ref] ?? null),
    pushedRefs: () => pushed,
    stderr: (text) => void (stderr += text),
  };
  return {
    code: checkPushedJournals("/virtual", resolved, deps),
    stderr,
    reads,
  };
}

test("push check: a clean push to the release ref passes and reads base then sha", () => {
  const r = pushRun(refLine(SHA), {
    "origin/main": [e(0, 1)],
    [SHA]: [e(0, 1), e(1, 2)],
  });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.deepEqual(r.reads, ["origin/main", SHA]);
});

test("push check: a rewritten released entry fails with the expected output format", () => {
  const r = pushRun(refLine(SHA), {
    "origin/main": [e(0, 1), e(1, 2)],
    [SHA]: [e(0, 1)],
  });
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    `drizzle/meta/_journal.json  ${RELEASED}  Released migration t1 (idx 1) was removed from the journal.\n`
  );
});

test("push check: ordering problems in a pushed journal fail even with an unchanged base", () => {
  const r = pushRun(refLine(SHA), {
    "origin/main": [e(0, 1)],
    [SHA]: [e(0, 1), e(1, 1)],
  });
  assert.equal(r.code, 1);
  assert.match(
    r.stderr,
    new RegExp(
      `${ORDER}  Journal when not strictly increasing at t1 \\(1 then 1\\)\\.`
    )
  );
});

test("push check: a pushed sha without a journal reports every released entry as removed", () => {
  const r = pushRun(refLine(SHA), { "origin/main": [e(0, 1), e(1, 2)] });
  assert.equal(r.code, 1);
  assert.equal(r.stderr.trim().split("\n").length, 2);
});

test("push check: only pushes to the release ref count, deletions are ignored", () => {
  const input = [
    refLine(SHA, "refs/heads/feature"),
    refLine("0".repeat(40)),
    refLine(OTHER_SHA),
    "",
  ].join("\n");
  const r = pushRun(input, {
    "origin/main": [e(0, 1)],
    [OTHER_SHA]: [e(0, 1)],
    [SHA]: [],
  });
  assert.equal(r.code, 0);
  assert.deepEqual(r.reads, ["origin/main", OTHER_SHA]);
});

test("push check: a terminal stdin checks HEAD", () => {
  const r = pushRun(null, { "origin/main": [e(0, 1)], HEAD: [] });
  assert.equal(r.code, 1);
  assert.deepEqual(r.reads, ["origin/main", "HEAD"]);
});

test("push check: every pushed sha is checked, in order", () => {
  const r = pushRun([refLine(SHA), refLine(OTHER_SHA)].join("\n"), {
    "origin/main": [e(0, 1)],
    [SHA]: [e(0, 1)],
    [OTHER_SHA]: [e(0, 9, "moved")],
  });
  assert.equal(r.code, 1);
  assert.match(
    r.stderr,
    /Released migration idx 0 changed: t0@1 is now moved@9/
  );
  assert.deepEqual(r.reads, ["origin/main", SHA, OTHER_SHA]);
});

test("push check: nothing pushed to the release ref exits 0 without reading the base", () => {
  const r = pushRun(refLine(SHA, "refs/heads/feature"), {});
  assert.equal(r.code, 0);
  assert.deepEqual(r.reads, []);
});

test("push check: an unreadable base ref fails with a fetch hint", () => {
  const r = pushRun(refLine(SHA), { [SHA]: [e(0, 1)] });
  assert.equal(r.code, 1);
  assert.equal(
    r.stderr,
    "Cannot read the migration journal at origin/main; fetch it and push again\n"
  );
});

test("push check: requireBaseAlways reads the base even when nothing is pushed", () => {
  const rules = { [RELEASED]: { options: { requireBaseAlways: true } } };
  const missing = pushRun(refLine(SHA, "refs/heads/feature"), {}, {}, rules);
  assert.equal(missing.code, 1);
  assert.deepEqual(missing.reads, ["origin/main"]);
  const present = pushRun(
    refLine(SHA, "refs/heads/feature"),
    { "origin/main": [e(0, 1)] },
    {},
    rules
  );
  assert.equal(present.code, 0);
});

test("push check: configured release ref, base ref and journal path", () => {
  const config = {
    migrations: {
      journal: JOURNAL,
      releaseRef: "refs/heads/release",
      baseRef: "origin/release",
    },
  };
  const r = pushRun(
    [refLine(SHA, MAIN), refLine(OTHER_SHA, "refs/heads/release")].join("\n"),
    { "origin/release": [e(0, 1)], [OTHER_SHA]: [] },
    config
  );
  assert.equal(r.code, 1);
  assert.deepEqual(r.reads, ["origin/release", OTHER_SHA]);
  assert.ok(r.stderr.startsWith(`${JOURNAL}  ${RELEASED}  `));
});

test("push check: the order report option is applied", () => {
  const journals = { "origin/main": [e(0, 1)], [SHA]: [e(0, 1), e(0, 1)] };
  const field = pushRun(refLine(SHA), journals);
  assert.equal(field.stderr.trim().split("\n").length, 2);
  const entry = pushRun(
    refLine(SHA),
    journals,
    {},
    { [ORDER]: { options: { report: "per-entry" } } }
  );
  assert.equal(
    entry.stderr.trim(),
    `drizzle/meta/_journal.json  ${ORDER}  Journal not strictly increasing at t0`
  );
});

test("push check: turning a rule off drops its violations, and the released rule off skips the base", () => {
  const journals = {
    "origin/main": [e(0, 1), e(1, 2)],
    [SHA]: [e(1, 2, "x"), e(0, 1)],
  };
  const orderOff = pushRun(refLine(SHA), journals, {}, { [ORDER]: "off" });
  assert.equal(orderOff.code, 1);
  assert.ok(!orderOff.stderr.includes(ORDER));
  const releasedOff = pushRun(
    refLine(SHA),
    { [SHA]: [e(1, 2, "x"), e(0, 1)] },
    {},
    { [RELEASED]: "off" }
  );
  assert.equal(releasedOff.code, 1);
  assert.ok(!releasedOff.stderr.includes(RELEASED));
  assert.deepEqual(releasedOff.reads, [SHA]);
  const bothOff = pushRun(
    refLine(SHA),
    journals,
    {},
    { [ORDER]: "off", [RELEASED]: "off" }
  );
  assert.equal(bothOff.code, 0);
});

test("push check: the message option replaces the wording of that rule only", () => {
  const r = pushRun(
    refLine(SHA),
    { "origin/main": [e(0, 1)], [SHA]: [] },
    {},
    { [RELEASED]: { options: { message: "released entries are frozen" } } }
  );
  assert.equal(
    r.stderr,
    `drizzle/meta/_journal.json  ${RELEASED}  released entries are frozen\n`
  );
});

test("runJournalCheck keeps the signature index.ts imports", () => {
  assert.equal(typeof runJournalCheck, "function");
  assert.equal(runJournalCheck.length, 2);
});
