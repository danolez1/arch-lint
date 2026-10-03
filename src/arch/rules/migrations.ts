import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inLayer, levelFor, settingsFor } from "../config";
import { lineAt } from "../source";
import type {
  ProjectContext,
  ProjectRule,
  ResolvedConfig,
  Rule,
  RuleContext,
  Violation,
} from "../types";
import { messageFor, option, violation } from "./util";

const TX_CONTROL = "migration-no-tx-control";
const DEFAULT_PRIVILEGES = "migration-no-default-privileges-for-role";
const JOURNAL_ORDER = "migration-journal-order";
const RELEASED_IMMUTABLE = "migration-released-immutable";
const NO_PUSH = "no-drizzle-push";

const DEFAULT_JOURNAL = "drizzle/meta/_journal.json";

export interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

/** per-field reports idx and when separately, per-entry reports one violation per out-of-order entry. */
export type OrderReport = "per-field" | "per-entry";

export interface JournalOptions {
  journalPath?: string;
  orderReport?: OrderReport;
}

// Masked so statements inside comments and strings never match; offsets stay so line numbers hold.
export function maskSql(sql: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return sql.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|(\$[A-Za-z_]*\$)[\s\S]*?\1/g,
    blank
  );
}

const TX_STATEMENT =
  /(?<=^|;)(\s*)(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION)(?:\s+(?:WORK|TRANSACTION|AND\s+(?:NO\s+)?CHAIN))*\s*;/gi;
const DEFAULT_PRIVILEGES_FOR_ROLE =
  /ALTER\s+DEFAULT\s+PRIVILEGES\b[^;]*?\bFOR\s+(ROLE|USER)\s+[^\s;]+/gi;

export function scanTxControl(
  file: string,
  sql: string,
  grandfathered: readonly string[] = []
): Violation[] {
  if (grandfathered.includes(file.split("/").pop() ?? file)) return [];
  const masked = maskSql(sql);
  return [...masked.matchAll(TX_STATEMENT)].map((m) =>
    violation(
      file,
      lineAt(masked, (m.index ?? 0) + (m[1]?.length ?? 0)),
      TX_CONTROL,
      `${m[2]?.toUpperCase()}; in a migration ends drizzle's wrapping transaction. Remove it; the migrator already runs each file in a transaction.`
    )
  );
}

export function scanDefaultPrivileges(file: string, sql: string): Violation[] {
  const masked = maskSql(sql);
  return [...masked.matchAll(DEFAULT_PRIVILEGES_FOR_ROLE)].map((m) =>
    violation(
      file,
      lineAt(masked, m.index ?? 0),
      DEFAULT_PRIVILEGES,
      "ALTER DEFAULT PRIVILEGES FOR ROLE hardcodes the owner role, which differs per environment. Omit FOR ROLE so it applies to the migrating role."
    )
  );
}

export function parseJournal(text: string): JournalEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    return Array.isArray(entries) ? (entries as JournalEntry[]) : null;
  } catch {
    return null;
  }
}

export function checkJournal(
  current: JournalEntry[],
  base: JournalEntry[] | null,
  opts: JournalOptions = {}
): Violation[] {
  const file = opts.journalPath ?? DEFAULT_JOURNAL;
  const perEntry = opts.orderReport === "per-entry";
  const found: Violation[] = [];
  const order = (message: string) =>
    found.push(violation(file, 0, JOURNAL_ORDER, message));
  const released = (message: string) =>
    found.push(violation(file, 0, RELEASED_IMMUTABLE, message));

  for (let i = 1; i < current.length; i++) {
    const prev = current[i - 1];
    const cur = current[i];
    if (!prev || !cur) continue;
    const idxBad = cur.idx <= prev.idx;
    const whenBad = cur.when <= prev.when;
    if (perEntry) {
      if (idxBad || whenBad)
        order(`Journal not strictly increasing at ${cur.tag}`);
      continue;
    }
    if (idxBad)
      order(
        `Journal idx not strictly increasing at ${cur.tag} (${prev.idx} then ${cur.idx}).`
      );
    if (whenBad)
      order(
        `Journal when not strictly increasing at ${cur.tag} (${prev.when} then ${cur.when}).`
      );
  }

  if (!base) return found;
  const byIdx = new Map(current.map((entry) => [entry.idx, entry]));
  for (const entry of base) {
    const now = byIdx.get(entry.idx);
    if (!now) {
      released(
        `Released migration ${entry.tag} (idx ${entry.idx}) was removed from the journal.`
      );
    } else if (now.tag !== entry.tag || now.when !== entry.when) {
      released(
        `Released migration idx ${entry.idx} changed: ${entry.tag}@${entry.when} is now ${now.tag}@${now.when}. Add a new migration instead.`
      );
    }
  }
  return found;
}

export type JournalReader = (
  root: string,
  ref: string,
  journalPath: string
) => JournalEntry[] | null;

export const gitJournalReader: JournalReader = (root, ref, journalPath) => {
  const relative = journalPath.replace(/^\.\//, "");
  const res = spawnSync("git", ["show", `${ref}:./${relative}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return res.status === 0 ? parseJournal(res.stdout) : null;
};

function migrationFiles(ctx: ProjectContext): string[] {
  const dir = ctx.config.migrations.dir
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
  const prefix = dir === "." || dir === "" ? "" : `${dir}/`;
  const direct = (p: string) =>
    p.startsWith(prefix) &&
    !p.slice(prefix.length).includes("/") &&
    p.endsWith(".sql");
  const found = new Set(ctx.listFiles([".sql"]).filter(direct));
  try {
    for (const name of readdirSync(path.join(ctx.root, prefix))) {
      if (name.endsWith(".sql")) found.add(`${prefix}${name}`);
    }
  } catch {
    // The migration directory is usually outside the scan roots, and an in-memory project has no disk.
  }
  return [...found].sort();
}

function scanSqlFiles(
  ctx: ProjectContext,
  scan: (file: string, sql: string) => Violation[]
): Violation[] {
  const found = migrationFiles(ctx).flatMap((file) =>
    scan(file, ctx.read(file) ?? "")
  );
  return found.map((v) => ({ ...v, message: messageFor(ctx, v.message) }));
}

const txControlRule: ProjectRule = {
  kind: "project",
  id: TX_CONTROL,
  description:
    "Migrations must not contain top-level BEGIN, COMMIT, ROLLBACK or similar; the migrator wraps each file itself. Option grandfathered lists released file names to skip.",
  check(ctx) {
    const grandfathered = option<string[]>(ctx, "grandfathered", []);
    return scanSqlFiles(ctx, (file, sql) =>
      scanTxControl(file, sql, grandfathered)
    );
  },
};

const defaultPrivilegesRule: ProjectRule = {
  kind: "project",
  id: DEFAULT_PRIVILEGES,
  description:
    "ALTER DEFAULT PRIVILEGES in a migration must not name an owner role with FOR ROLE or FOR USER.",
  check: (ctx) => scanSqlFiles(ctx, scanDefaultPrivileges),
};

const journalOrderRule: ProjectRule = {
  kind: "project",
  id: JOURNAL_ORDER,
  description:
    "Journal idx and when values must be strictly increasing. Option report is per-field or per-entry, workingTree turns the normal-run check off.",
  check(ctx) {
    if (!option(ctx, "workingTree", true)) return [];
    const journalPath = ctx.config.migrations.journal;
    const text = ctx.read(journalPath);
    if (text === null) return [];
    const entries = parseJournal(text);
    if (!entries) {
      return [
        violation(
          journalPath,
          0,
          JOURNAL_ORDER,
          "The migration journal is not valid JSON with an entries array."
        ),
      ];
    }
    const orderReport = option<OrderReport>(ctx, "report", "per-field");
    return checkJournal(entries, null, { journalPath, orderReport }).map(
      (v) => ({
        ...v,
        message: messageFor(ctx, v.message),
      })
    );
  },
};

/** Takes the git reader as a parameter so tests can run it without a repository. */
export function releasedImmutableRule(
  readJournal: JournalReader = gitJournalReader
): ProjectRule {
  return {
    kind: "project",
    id: RELEASED_IMMUTABLE,
    description:
      "A migration already in the base ref's journal must not be removed, renamed or re-timestamped. Always checked on push; checked in a normal run only with option workingTree.",
    check(ctx) {
      if (!option(ctx, "workingTree", false)) return [];
      const journalPath = ctx.config.migrations.journal;
      const text = ctx.read(journalPath);
      const entries = text === null ? null : parseJournal(text);
      if (!entries) return [];
      const { baseRef } = ctx.config.migrations;
      const base = readJournal(ctx.root, baseRef, journalPath);
      if (!base) {
        process.stderr.write(
          `${RELEASED_IMMUTABLE} skipped: cannot read ${baseRef}:${journalPath}\n`
        );
        return [];
      }
      return checkJournal(entries, base, { journalPath })
        .filter((v) => v.rule === RELEASED_IMMUTABLE)
        .map((v) => ({ ...v, message: messageFor(ctx, v.message) }));
    },
  };
}

const releasedRule = releasedImmutableRule();

const noPushRule: ProjectRule = {
  kind: "project",
  id: NO_PUSH,
  description:
    "Package scripts must not run a schema push; schema changes go through generated migrations. Options files and pattern change what is read and matched.",
  check(ctx) {
    const files = option<string[]>(ctx, "files", ["package.json"]);
    const command = new RegExp(
      option(ctx, "pattern", "drizzle-kit\\s+push\\b")
    );
    const found: Violation[] = [];
    for (const file of files) {
      const text = ctx.read(file);
      if (text === null) continue;
      let scripts: Record<string, unknown> = {};
      try {
        scripts =
          (JSON.parse(text) as { scripts?: Record<string, unknown> } | null)
            ?.scripts ?? {};
      } catch {
        continue;
      }
      for (const [name, value] of Object.entries(scripts)) {
        if (typeof value !== "string" || !command.test(value)) continue;
        const line = lineAt(text, Math.max(0, text.indexOf(`"${name}"`)));
        const message = `Script "${name}" runs drizzle-kit push; schema changes go through db:generate and db:migrate`;
        found.push(violation(file, line, NO_PUSH, messageFor(ctx, message)));
      }
    }
    return found;
  },
};

export const RULES: Rule[] = [
  txControlRule,
  defaultPrivilegesRule,
  journalOrderRule,
  releasedRule,
  noPushRule,
];

export interface PushCheckDeps {
  readJournal(ref: string): JournalEntry[] | null;
  /** What git's pre-push hook wrote to stdin, or null when stdin is a terminal. */
  pushedRefs(): string | null;
  stderr(text: string): void;
}

function contextFor(
  root: string,
  config: ResolvedConfig,
  rule: Rule
): RuleContext {
  return {
    root,
    config,
    options: settingsFor(config, rule).options ?? {},
    inLayer: (p, layer) => inLayer(config, p, layer),
    hasLayer: (layer) => config.layers[layer] !== undefined,
  };
}

// Only pushes to the release ref count; a branch behind it would read as removed entries.
function releasePushShas(pushed: string | null, releaseRef: string): string[] {
  if (pushed === null) return ["HEAD"];
  return pushed
    .split("\n")
    .map((line) => line.split(" "))
    .flatMap(([, sha, remoteRef]) =>
      remoteRef === releaseRef && sha && !/^0+$/.test(sha) ? [sha] : []
    );
}

export function checkPushedJournals(
  root: string,
  config: ResolvedConfig,
  deps: PushCheckDeps
): number {
  const orderOn = levelFor(config, journalOrderRule) !== "off";
  const releasedOn = levelFor(config, releasedRule) !== "off";
  const orderCtx = contextFor(root, config, journalOrderRule);
  const releasedCtx = contextFor(root, config, releasedRule);
  const { releaseRef, baseRef, journal } = config.migrations;

  const shas = releasePushShas(deps.pushedRefs(), releaseRef);
  if (
    shas.length === 0 &&
    !(releasedOn && option(releasedCtx, "requireBaseAlways", false))
  )
    return 0;

  let base: JournalEntry[] | null = null;
  if (releasedOn) {
    base = deps.readJournal(baseRef);
    if (!base) {
      deps.stderr(
        `Cannot read the migration journal at ${baseRef}; fetch it and push again\n`
      );
      return 1;
    }
  }

  const orderReport = option<OrderReport>(orderCtx, "report", "per-field");
  // A pushed commit without a journal drops every released entry, so it must fail too.
  const found = shas
    .flatMap((sha) =>
      checkJournal(deps.readJournal(sha) ?? [], base, {
        journalPath: journal,
        orderReport,
      })
    )
    .filter((v) => (v.rule === JOURNAL_ORDER ? orderOn : releasedOn))
    .map((v) => ({
      ...v,
      message: messageFor(
        v.rule === JOURNAL_ORDER ? orderCtx : releasedCtx,
        v.message
      ),
    }));
  for (const v of found) deps.stderr(`${v.file}  ${v.rule}  ${v.message}\n`);
  return found.length > 0 ? 1 : 0;
}

function readStdin(): string | null {
  if (process.stdin.isTTY) return null;
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

export async function runJournalCheck(
  root: string,
  config: ResolvedConfig
): Promise<number> {
  return checkPushedJournals(root, config, {
    readJournal: (ref) =>
      gitJournalReader(root, ref, config.migrations.journal),
    pushedRefs: readStdin,
    stderr: (text) => void process.stderr.write(text),
  });
}
