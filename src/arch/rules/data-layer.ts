import { importsOf, isCommentLine, lineAt } from "../source";
import type {
  FileRule,
  ProjectRule,
  Rule,
  RuleContext,
  Violation,
} from "../types";
import { messageFor, option, violation } from "./util";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compile(sources: readonly string[]): RegExp[] {
  return sources.map((source) => new RegExp(source));
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** An empty list must match nothing, never every word boundary. */
function alternation(words: readonly string[]): string {
  return words.length === 0
    ? "(?!)"
    : `(?:${words.map(escapeRegExp).join("|")})`;
}

/** A layer the config never defined matches every path, which would skip or select everything by accident. */
function inDefinedLayer(
  ctx: RuleContext,
  path: string,
  layer: string
): boolean {
  return ctx.hasLayer(layer) && ctx.inLayer(path, layer);
}

function skippedByLayer(
  ctx: RuleContext,
  path: string,
  layers: readonly string[]
): boolean {
  return layers.some((layer) => inDefinedLayer(ctx, path, layer));
}

// A clause never holds quotes or semicolons, so a side-effect import cannot swallow the next statement.
const IMPORT_CLAUSE =
  "(?:[\\w$]+(?:\\s*,\\s*(?:\\{[^}]*\\}|\\*\\s+as\\s+[\\w$]+))?|\\{[^}]*\\}|\\*\\s+as\\s+[\\w$]+)";
const IMPORT_FROM = new RegExp(
  `\\bimport\\s+(type\\s+)?(${IMPORT_CLAUSE})\\s*from\\s*["']([^"']+)["']`,
  "g"
);
const EXPORT_FROM =
  /\bexport\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*["']([^"']+)["']/g;
const EXPORT_LIST =
  /\bexport\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*["']([^"']+)["'])?/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function valueSpecifiers(clause: string): string[] {
  const names: string[] = [];
  const braced = clause.match(/\{([\s\S]*)\}/);
  const head = clause
    .replace(/\{[\s\S]*\}/, "")
    .replace(/,/g, "")
    .trim();
  if (head) names.push(head.startsWith("*") ? "*" : head);
  if (braced?.[1]) {
    for (const raw of braced[1].split(",")) {
      const spec = raw.trim();
      if (!spec || spec.startsWith("type ")) continue;
      names.push(spec.split(/\s+as\s+/)[0]?.trim() ?? spec);
    }
  }
  return names.filter(Boolean);
}

interface Statement {
  source: string;
  values: string[];
  typeKeyword: boolean;
  startLine: number;
  sourceLine: number;
  index: number;
}

function statements(code: string, pattern: RegExp): Statement[] {
  const found: Statement[] = [];
  for (const match of code.matchAll(pattern)) {
    const source = match[3] ?? "";
    const index = match.index ?? 0;
    found.push({
      source,
      values: valueSpecifiers(match[2] ?? ""),
      typeKeyword: Boolean(match[1]),
      startLine: lineAt(code, index),
      sourceLine: lineAt(code, index + match[0].lastIndexOf(source)),
      index,
    });
  }
  return found;
}

const DB_MODULES = ["^drizzle-orm(/|$)", "^(postgres|pg)(/|$)"];

const noDbOutsideModels: FileRule = {
  kind: "file",
  id: "no-db-outside-models",
  description:
    "Only the models layer may hold a database handle or build a query. Value imports of query builders, drivers, table definitions or handle names are flagged elsewhere, and so are barrels that re-export a handle.",
  check(file, ctx) {
    if (
      skippedByLayer(
        ctx,
        file.path,
        option<string[]>(ctx, "skipLayers", ["models"])
      )
    )
      return [];
    const modulesSource = option<string[]>(ctx, "modules", DB_MODULES);
    const modules = compile(modulesSource);
    const packages = compile(option<string[]>(ctx, "packages", modulesSource));
    const handles = new Set(
      option<string[]>(ctx, "handleNames", ["db", "pool"])
    );
    const inRoutes = inDefinedLayer(ctx, file.path, "routes");
    const found: Violation[] = [];
    const push = (line: number, text: string): void => {
      found.push(
        violation(
          file.path,
          line,
          "no-db-outside-models",
          messageFor(ctx, text)
        )
      );
    };
    const routeOr = (source: string, text: string): string =>
      inRoutes
        ? `Routes must not touch the database ("${source}"). Call a model function instead`
        : text;

    for (const s of statements(file.code, IMPORT_FROM)) {
      if (s.typeKeyword || s.values.length === 0) continue;
      if (matchesAny(modules, s.source)) {
        push(
          s.startLine,
          routeOr(
            s.source,
            `Imports ${s.values.join(", ")} from "${s.source}" outside the models layer. Move the query into a model function, or use a type-only import`
          )
        );
      } else if (s.values.includes("*") && matchesAny(packages, s.source)) {
        push(
          s.startLine,
          `Namespace-imports "${s.source}" outside the models layer, which exposes its database handles. Import the model function instead`
        );
      } else {
        const named = s.values.filter((value) => handles.has(value));
        if (named.length > 0) {
          push(
            s.startLine,
            `Imports database handle(s) ${named.join(", ")} from "${s.source}" outside the models layer. Only models may hold a database handle`
          );
        }
      }
    }

    const flaggedExports = new Set<number>();
    if (option<boolean>(ctx, "reExports", true)) {
      for (const s of statements(file.code, EXPORT_FROM)) {
        if (s.typeKeyword) continue;
        if (
          matchesAny(modules, s.source) ||
          (s.values.includes("*") && matchesAny(packages, s.source))
        ) {
          flaggedExports.add(s.index);
          push(
            s.startLine,
            routeOr(
              s.source,
              `Re-exports from "${s.source}" outside the models layer. Only models may hold a database handle or build a query`
            )
          );
        }
      }
    }

    for (const match of file.code.matchAll(EXPORT_LIST)) {
      if (match[1] || flaggedExports.has(match.index ?? 0)) continue;
      const named = valueSpecifiers(`{${match[2] ?? ""}}`).filter((value) =>
        handles.has(value)
      );
      if (named.length > 0) {
        push(
          lineAt(file.code, match.index ?? 0),
          `Re-exports database handle(s) ${named.join(", ")} outside the models layer. A barrel must not hand the database to routes or services`
        );
      }
    }

    for (const match of file.code.matchAll(DYNAMIC_IMPORT)) {
      const source = match[1] ?? "";
      if (!matchesAny(packages, source)) continue;
      push(
        lineAt(file.code, match.index ?? 0),
        routeOr(
          source,
          `Dynamically imports "${source}" outside the models layer. Only models may hold a database handle`
        )
      );
    }
    return found;
  },
};

const noDbInRoutes: FileRule = {
  kind: "file",
  id: "no-db-in-routes",
  description:
    "Route handlers must not import a database module at all, so they call model functions. Unlike no-db-outside-models it looks at module names only and can be pointed at the project's own database package.",
  defaultLayer: "routes",
  check(file, ctx) {
    const modules = compile(option<string[]>(ctx, "modules", DB_MODULES));
    const flagTypes = option<string>(ctx, "typeImports", "allow") === "flag";
    const message = messageFor(
      ctx,
      "Route files must not import the database directly. Call a model function instead"
    );
    return [
      ...statements(file.code, IMPORT_FROM),
      ...statements(file.code, EXPORT_FROM),
    ]
      .filter((s) => matchesAny(modules, s.source))
      .filter((s) => flagTypes || (!s.typeKeyword && s.values.length > 0))
      .map((s) =>
        violation(file.path, s.sourceLine, "no-db-in-routes", message)
      );
  },
};

const noDirectWriteAuditInRoutes: FileRule = {
  kind: "file",
  id: "no-direct-write-audit-in-routes",
  description:
    "Routes must go through the fail-open audit wrapper, never the raw audit write primitive. Flags value imports of the primitive, including one buried in a multi-line import list.",
  defaultLayer: "routes",
  check(file, ctx) {
    const names = new RegExp(
      `\\b${alternation(option<string[]>(ctx, "names", ["writeAuditEntry"]))}\\b`
    );
    const message = messageFor(
      ctx,
      "Routes must call the fail-open audit wrapper instead of the raw audit write primitive. The primitive belongs in services or models"
    );
    const codeLines = file.code.split("\n");
    const found: Violation[] = [];
    for (const s of statements(file.code, IMPORT_FROM)) {
      if (s.typeKeyword || s.values.length === 0) continue;
      for (let line = s.startLine; line <= s.sourceLine; line++) {
        if (names.test(codeLines[line - 1] ?? "")) {
          found.push(
            violation(
              file.path,
              line,
              "no-direct-write-audit-in-routes",
              message
            )
          );
        }
      }
    }
    return found;
  },
};

const CACHE_MODULES = ["^next/cache$", "^(ioredis|redis|@upstash/redis)(/|$)"];

const noCacheInModels: FileRule = {
  kind: "file",
  id: "no-cache-in-models",
  description:
    "Models return fresh data, so they must not import a cache or cache invalidation module. Type-only imports count too, because the module is still a dependency.",
  defaultLayer: "models",
  check(file, ctx) {
    const modules = compile(option<string[]>(ctx, "modules", CACHE_MODULES));
    return importsOf(file)
      .filter((ref) => matchesAny(modules, ref.source))
      .map((ref) =>
        violation(
          file.path,
          ref.line,
          "no-cache-in-models",
          messageFor(
            ctx,
            `Models return fresh data; cache in the caller instead (${ref.source})`
          )
        )
      );
  },
};

const UPWARD_MODULES = [
  "^(?:\\.{1,2}|@|~)/(?:.*/)?(services|workers|components|queue|store)(?:/|$)",
];

const modelsStayBelowServices: FileRule = {
  kind: "file",
  id: "models-stay-below-services",
  description:
    "Models must not import from a higher layer such as services, workers, queues or components. Infrastructure that does work belongs to the caller, not to a query function.",
  defaultLayer: "models",
  check(file, ctx) {
    const modules = compile(option<string[]>(ctx, "modules", UPWARD_MODULES));
    return importsOf(file)
      .filter((ref) => !ref.typeOnly && matchesAny(modules, ref.source))
      .map((ref) =>
        violation(
          file.path,
          ref.line,
          "models-stay-below-services",
          messageFor(
            ctx,
            `Models must not import from a higher layer (${ref.source}); pass the result in from the caller`
          )
        )
      );
  },
};

// Block boundaries come from declarations at column 0, which avoids brace counting through strings.
const TOP_LEVEL_DECL =
  /^(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|const\s+\w|let\s+\w|var\s+\w)/;
// Indented closures and object-literal methods start their own block, or a service factory reads as one function.
const NESTED_DECL = new RegExp(
  `^(?:${TOP_LEVEL_DECL.source.slice(1)}| {2}(async\\s+)?function\\s+\\w| {4}async\\s+\\w+\\s*[(<])`
);

interface BlockLine {
  no: number;
  text: string;
}

function blocksOf(lines: readonly string[], blockStart: string): BlockLine[][] {
  const start = blockStart === "top-level" ? TOP_LEVEL_DECL : NESTED_DECL;
  const blocks: BlockLine[][] = [];
  let current: BlockLine[] | null = null;
  for (let index = 0; index < lines.length; index++) {
    const text = lines[index] ?? "";
    if (start.test(text)) {
      current = [];
      blocks.push(current);
    }
    if (current && !isCommentLine(text)) current.push({ no: index + 1, text });
  }
  return blocks;
}

interface TxPatterns {
  blockStart: string;
  write: RegExp;
  remove: RegExp;
  insert: RegExp;
  transaction: RegExp;
}

function txPatterns(ctx: RuleContext): TxPatterns {
  const handles = alternation(option<string[]>(ctx, "dbHandles", ["db"]));
  const names = alternation(
    option<string[]>(ctx, "transactionNames", [
      "withTransaction",
      "runInTransaction",
    ])
  );
  const call = (verbs: string): RegExp =>
    new RegExp(`\\b${handles}\\s*\\.\\s*(?:${verbs})\\s*\\(`);
  return {
    blockStart: option<string>(ctx, "blockStart", "nested"),
    write: call("insert|update|delete"),
    remove: call("delete"),
    insert: call("insert"),
    transaction: new RegExp(
      `\\b${names}\\b|\\b${handles}\\s*\\.\\s*transaction\\s*\\(`
    ),
  };
}

type WriteKind = "insert" | "update" | "delete";

interface Write {
  line: number;
  kind: WriteKind;
}

interface WriteBlock {
  writes: Write[];
  inTransaction: boolean;
}

function writeBlocks(
  lines: readonly string[],
  patterns: TxPatterns
): WriteBlock[] {
  return blocksOf(lines, patterns.blockStart).map((block) => {
    const writes: Write[] = [];
    let inTransaction = false;
    for (const { no, text } of block) {
      if (patterns.transaction.test(text)) inTransaction = true;
      if (!patterns.write.test(text)) continue;
      const kind: WriteKind = patterns.remove.test(text)
        ? "delete"
        : patterns.insert.test(text)
          ? "insert"
          : "update";
      writes.push({ line: no, kind });
    }
    return { writes, inTransaction };
  });
}

// A failed insert after a committed delete leaves the table empty.
function deleteThenInsert(writes: readonly Write[]): Write | null {
  const first = writes.findIndex((write) => write.kind === "delete");
  if (first === -1) return null;
  return writes.slice(first + 1).some((write) => write.kind === "insert")
    ? (writes[first] ?? null)
    : null;
}

const txRequiredMultiWrite: FileRule = {
  kind: "file",
  id: "tx-required-multi-write",
  description:
    "A function with two or more direct database writes needs a transaction, or a failure between them leaves partial state. Writes behind model functions are covered by tx-service-orchestration.",
  defaultLayer: "backend",
  check(file, ctx) {
    if (skippedByLayer(ctx, file.path, option<string[]>(ctx, "skipLayers", [])))
      return [];
    const defer = option<boolean>(ctx, "deferDeleteThenInsert", false);
    const message = messageFor(
      ctx,
      "Function performs 2 or more direct database writes without a transaction. Wrap them in the transaction helper so they commit or roll back together"
    );
    const found: Violation[] = [];
    for (const { writes, inTransaction } of writeBlocks(
      file.lines,
      txPatterns(ctx)
    )) {
      if (inTransaction || writes.length < 2) continue;
      if (defer && deleteThenInsert(writes)) continue;
      found.push(
        violation(
          file.path,
          writes[0]?.line ?? 1,
          "tx-required-multi-write",
          message
        )
      );
    }
    return found;
  },
};

const txDeleteThenInsert: FileRule = {
  kind: "file",
  id: "tx-delete-then-insert",
  description:
    "A delete followed by an insert in one function needs a transaction, or a failed insert leaves the table empty. It stays on for bulk import paths where tx-required-multi-write is relaxed.",
  defaultLayer: "backend",
  check(file, ctx) {
    if (skippedByLayer(ctx, file.path, option<string[]>(ctx, "skipLayers", [])))
      return [];
    const message = messageFor(
      ctx,
      "A delete followed by an insert outside a transaction leaves the table empty if the insert fails. Wrap both in a transaction"
    );
    const found: Violation[] = [];
    for (const { writes, inTransaction } of writeBlocks(
      file.lines,
      txPatterns(ctx)
    )) {
      const remove = inTransaction ? null : deleteThenInsert(writes);
      if (remove)
        found.push(
          violation(file.path, remove.line, "tx-delete-then-insert", message)
        );
    }
    return found;
  },
};

const FUNCTION_NAME =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/;
const CONST_FUNCTION_NAME = /^(?:export\s+)?const\s+(\w+)\s*=/;

function mutatingNames(lines: readonly string[], write: RegExp): Set<string> {
  const names = new Set<string>();
  let name: string | null = null;
  let hasWrite = false;
  const flush = (): void => {
    if (name && hasWrite) names.add(name);
  };
  for (const line of lines) {
    const declared =
      line.match(FUNCTION_NAME) ?? line.match(CONST_FUNCTION_NAME);
    if (declared) {
      flush();
      name = declared[1] ?? null;
      hasWrite = false;
    }
    if (!isCommentLine(line) && write.test(line)) hasWrite = true;
  }
  flush();
  return names;
}

const txServiceOrchestration: ProjectRule = {
  kind: "project",
  id: "tx-service-orchestration",
  description:
    "A service or worker function that calls two or more distinct mutating model functions needs a transaction. Sagas that span network calls cannot hold one and are exempted per file. Needs the models and services layers to be defined.",
  check(ctx) {
    const modelsLayer = option<string>(ctx, "modelsLayer", "models");
    const servicesLayer = option<string>(ctx, "servicesLayer", "services");
    if (!ctx.hasLayer(modelsLayer) || !ctx.hasLayer(servicesLayer)) return [];

    const receivers = alternation(
      option<string[]>(ctx, "writeReceivers", ["db", "executor", "exec", "tx"])
    );
    const modelWrite = new RegExp(
      `\\b${receivers}\\s*\\.\\s*(?:insert|update|delete)\\s*\\(`
    );
    const mutating = new Set<string>();
    for (const file of ctx.files) {
      if (!ctx.inLayer(file.path, modelsLayer)) continue;
      for (const name of mutatingNames(file.lines, modelWrite))
        mutating.add(name);
    }
    if (mutating.size === 0) return [];

    const patterns = txPatterns(ctx);
    const callers = [...mutating].map((name) => ({
      name,
      call: new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`),
    }));
    const found: Violation[] = [];
    for (const file of ctx.files) {
      if (!ctx.inLayer(file.path, servicesLayer)) continue;
      for (const block of blocksOf(file.lines, patterns.blockStart)) {
        if (block.some((line) => patterns.transaction.test(line.text)))
          continue;
        const calls: { name: string; line: number }[] = [];
        for (const { no, text } of block) {
          for (const { name, call } of callers)
            if (call.test(text)) calls.push({ name, line: no });
        }
        const distinct = new Set(calls.map((c) => c.name));
        if (distinct.size < 2) continue;
        found.push(
          violation(
            file.path,
            calls[0]?.line ?? 1,
            "tx-service-orchestration",
            messageFor(
              ctx,
              `Function calls ${distinct.size} mutating model functions (${[...distinct].join(", ")}) without a transaction. Run them inside a transaction, or exempt a saga that spans network calls`
            )
          )
        );
      }
    }
    return found;
  },
};

export const RULES: Rule[] = [
  noDbOutsideModels,
  noDbInRoutes,
  noDirectWriteAuditInRoutes,
  noCacheInModels,
  modelsStayBelowServices,
  txRequiredMultiWrite,
  txDeleteThenInsert,
  txServiceOrchestration,
];
