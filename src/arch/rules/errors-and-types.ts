import { appliesTo, settingsFor } from "../config";
import { matchesAny } from "../paths";
import { isCommentLine, lineAt } from "../source";
import type {
  FileRule,
  ProjectContext,
  ProjectRule,
  Rule,
  RuleContext,
  Violation,
} from "../types";
import { messageFor, option, patternRule, violation } from "./util";

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function strings(ctx: RuleContext, key: string, fallback: string[]): string[] {
  const value = ctx.options[key];
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : fallback;
}

const noRawThrow = patternRule({
  id: "no-raw-throw",
  description:
    "Throw a project error class instead of a bare `new Error(...)`.",
  defaultLayer: "backend",
  pattern: (ctx) =>
    option<boolean>(ctx, "looseMatch", false)
      ? /throw\s+new\s+Error\s*\(/
      : /\bthrow\s+new\s+Error\s*\(/,
  message:
    "Throw a project-specific error subclass instead of a raw `new Error(...)`",
});

const noUnsafeErrorCast = patternRule({
  id: "no-unsafe-error-cast",
  description: "Do not cast a caught value to Error to read its message.",
  defaultLayer: "backend",
  pattern: /\(\s*\w+\s+as\s+Error\s*\)\s*\.\s*message/,
  message:
    "Narrow with `instanceof Error` or use a shared message helper instead of casting `(e as Error).message`",
});

const ERR_ID = "err-requires-error-code";

const errRequiresErrorCode: FileRule = {
  kind: "file",
  id: ERR_ID,
  description: "Result-style err() calls must carry an error code constant.",
  defaultLayer: "backend",
  check(file, ctx) {
    const callee = option(ctx, "callee", "err");
    const codeName = option(ctx, "codeName", "ErrorCode");
    const lookahead = option(ctx, "lookahead", 4);
    const call = new RegExp(`return\\s+${escapeRegExp(callee)}\\s*\\(`);
    const message = messageFor(
      ctx,
      `${callee}() needs a ${codeName} so callers can branch on the failure`
    );
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      if (isCommentLine(line) || !call.test(line)) return;
      // Formatters wrap long calls, so the code argument can sit a few lines below the opening.
      const window = file.lines.slice(index, index + lookahead + 1).join(" ");
      if (!window.includes(codeName))
        found.push(violation(file.path, index + 1, ERR_ID, message));
    });
    return found;
  },
};

const CATCH_BLOCK = /\bcatch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;
const CATCH_CALLBACK = /\.catch\(\s*(?:\([^)]*\)|\w+)?\s*=>\s*\{\s*\}\s*\)/g;
const CATCH_ID = "no-empty-catch";

const noEmptyCatch: FileRule = {
  kind: "file",
  id: CATCH_ID,
  description: "An empty catch block swallows the error.",
  check(file, ctx) {
    const message = messageFor(
      ctx,
      "Empty catch swallows the error; handle it or rethrow through the error handler"
    );
    const hits: number[] = [];
    for (const match of file.code.matchAll(CATCH_BLOCK)) {
      if ((match[1] ?? "").trim() === "") hits.push(match.index ?? 0);
    }
    if (option(ctx, "callbacks", true)) {
      for (const match of file.code.matchAll(CATCH_CALLBACK))
        hits.push(match.index ?? 0);
    }
    return hits.map((index) =>
      violation(file.path, lineAt(file.code, index), CATCH_ID, message)
    );
  },
};

const ANY_PATTERN = {
  basic: /\bas\s+any\b|:\s*any\b|<any>/,
  strict: /\bas\s+any\b|:\s*any\b|[<,]\s*any\s*[>,]|\bany\[\]/,
};
const ANY_SKIPPED_LINE = {
  basic: /^\s*import\s/,
  strict: /^\s*(import|export)\s.*from\s/,
};
const ANY_ID = "no-any";

const noAny: FileRule = {
  kind: "file",
  id: ANY_ID,
  description: "Do not use the `any` type.",
  check(file, ctx) {
    const variant =
      option<string>(ctx, "variant", "strict") === "basic" ? "basic" : "strict";
    const message = messageFor(
      ctx,
      "Avoid `any`; use a specific type, `unknown`, or a generic"
    );
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      if (isCommentLine(line) || ANY_SKIPPED_LINE[variant].test(line)) return;
      if (ANY_PATTERN[variant].test(line))
        found.push(violation(file.path, index + 1, ANY_ID, message));
    });
    return found;
  },
};

const typesInTypesFolder = patternRule({
  id: "types-in-types-folder",
  description: "Exported interfaces and type aliases belong in a types folder.",
  pattern: /^export\s+(interface\s+\w+|type\s+\w+\s*(<[^=]*>)?\s*=)/,
  message: "Exported interfaces and types live in the types folder",
  appliesTo: (file, ctx) =>
    !matchesAny(
      file.path,
      strings(ctx, "typesDirs", ["types/**", "**/types/**"])
    ),
});

const EXPORT_DECLARATION =
  /^export\s+(async\s+)?function\s|^export\s+const\s|^export\s+interface\s|^export\s+enum\s|^export\s+class\s/;
const TYPE_ALIAS = /^export\s+type\s+\w+\s*=/;
const ANY_TYPE_ALIAS = /^export\s+type\s+\w+/;
const RE_EXPORT = /^export\s+\{|^export\s+type\s+\{|^export\s+\*/;
const DECLARED_NAME =
  /export\s+(?:async\s+)?(?:function|const|interface|type|enum|class)\s+(\w+)/;
const JSDOC_ID = "require-export-jsdoc";

const requireExportJsdoc: FileRule = {
  kind: "file",
  id: JSDOC_ID,
  description: "Exported declarations need a JSDoc block.",
  check(file, ctx) {
    // An undefined layer matches every path, so only a layer the config defines can skip files.
    const skipped = strings(ctx, "skipLayers", []).some(
      (layer) =>
        ctx.config.layers[layer] !== undefined && ctx.inLayer(file.path, layer)
    );
    if (skipped) return [];
    if (
      option(ctx, "skipBarrelFiles", false) &&
      file.path.endsWith("/index.ts")
    )
      return [];
    if (option(ctx, "skipTsx", false) && file.isTsx) return [];
    const typeAlias = option(ctx, "genericTypes", true)
      ? ANY_TYPE_ALIAS
      : TYPE_ALIAS;
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      const trimmed = line.trimStart();
      if (RE_EXPORT.test(trimmed)) return;
      if (!EXPORT_DECLARATION.test(trimmed) && !typeAlias.test(trimmed)) return;
      let previous = "";
      for (let j = index - 1; j >= 0; j--) {
        const text = (file.lines[j] ?? "").trim();
        if (text === "") continue;
        previous = text;
        break;
      }
      if (previous.endsWith("*/")) return;
      const name = trimmed.match(DECLARED_NAME)?.[1] ?? "declaration";
      const message = messageFor(
        ctx,
        `Exported \`${name}\` is missing a JSDoc comment`
      );
      found.push(violation(file.path, index + 1, JSDOC_ID, message));
    });
    return found;
  },
};

/** Style-like words that legitimately stay strings; skipped when the watch list is read from enum files. */
const DEFAULT_IGNORED_VALUES = [
  "default",
  "primary",
  "secondary",
  "outline",
  "ghost",
  "link",
  "destructive",
  "small",
  "medium",
  "large",
  "none",
  "auto",
  "left",
  "right",
  "center",
  "top",
  "bottom",
  "horizontal",
  "vertical",
  "light",
  "dark",
  "system",
  "undefined",
  "string",
  "number",
  "boolean",
  "object",
  "function",
  "symbol",
  "bigint",
];
const DEFAULT_ENUM_VALUE_PATTERN = `=\\s*["']([a-z][a-z0-9_]{2,})["']`;
const DEFAULT_CONTEXTS = ["comparison", "loose", "reversed", "case", "schema"];
const ENUM_ID = "enum-literal-bypass";

interface Watched {
  value: string;
  enumName?: string;
}

function toWatched(raw: unknown): Watched[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((v): v is string => typeof v === "string" && v !== "")
      .map((value) => ({ value }));
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([value]) => value !== "")
      .map(([value, name]) => ({
        value,
        enumName: typeof name === "string" ? name : undefined,
      }));
  }
  return [];
}

function enumFileValues(ctx: ProjectContext): Watched[] {
  const raw = ctx.options.enumDir;
  const dirs = (Array.isArray(raw) ? raw : [raw]).filter(
    (d): d is string => typeof d === "string"
  );
  if (dirs.length === 0) return [];
  const prefixes = dirs.map(
    (d) => `${d.replace(/^\.\//, "").replace(/\/+$/, "")}/`
  );
  const recursive = option(ctx, "enumDirRecursive", false);
  const ignored = new Set(strings(ctx, "ignoreValues", DEFAULT_IGNORED_VALUES));
  const valuePattern = option(
    ctx,
    "enumValuePattern",
    DEFAULT_ENUM_VALUE_PATTERN
  );
  const found = new Map<string, Watched>();
  for (const path of ctx.listFiles([".ts"])) {
    const prefix = prefixes.find((p) => path.startsWith(p));
    if (!prefix || (!recursive && path.slice(prefix.length).includes("/")))
      continue;
    for (const match of (ctx.read(path) ?? "").matchAll(
      new RegExp(valuePattern, "g")
    )) {
      const value = match[1];
      if (value && !ignored.has(value)) found.set(value, { value });
    }
  }
  return [...found.values()];
}

interface Matcher extends Watched {
  compare: RegExp | null;
  union: RegExp | null;
}

function buildMatchers(ctx: ProjectContext): Matcher[] {
  const explicit = toWatched(ctx.options.values);
  const known = new Set(explicit.map((w) => w.value));
  const watched = [
    ...explicit,
    ...enumFileValues(ctx).filter((w) => !known.has(w.value)),
  ];
  const contexts = new Set(strings(ctx, "contexts", DEFAULT_CONTEXTS));
  const calls = strings(ctx, "schemaCalls", ["t.Literal"])
    .map(escapeRegExp)
    .join("|");

  const unionWatched = !contexts.has("union")
    ? []
    : ctx.options.unionValues === undefined
      ? watched
      : toWatched(ctx.options.unionValues);
  const names = new Map(watched.map((w) => [w.value, w.enumName]));
  const entries = [
    ...watched.map((w) => ({ ...w, comparable: true })),
    ...unionWatched
      .filter((w) => !names.has(w.value))
      .map((w) => ({ ...w, comparable: false })),
  ];
  const unionSet = new Set(unionWatched.map((w) => w.value));

  const quoted = (value: string) => `["']${escapeRegExp(value)}["']`;
  const matchers = entries.map((w): Matcher => {
    const q = quoted(w.value);
    const alternatives: string[] = [];
    if (w.comparable) {
      if (contexts.has("comparison")) alternatives.push(`(?:===|!==)\\s*${q}`);
      if (contexts.has("loose"))
        alternatives.push(`(?<![=!])(?:==|!=)(?!=)\\s*${q}`);
      if (contexts.has("reversed")) alternatives.push(`${q}\\s*(?:===|!==)`);
      if (contexts.has("case")) alternatives.push(`\\bcase\\s*${q}`);
      if (contexts.has("schema") && calls)
        alternatives.push(`(?:${calls})\\(\\s*${q}`);
    }
    return {
      value: w.value,
      enumName: w.enumName ?? names.get(w.value),
      compare:
        alternatives.length > 0 ? new RegExp(alternatives.join("|")) : null,
      union: unionSet.has(w.value)
        ? new RegExp(`${q}\\s*\\||\\|\\s*${q}`)
        : null,
    };
  });
  return matchers.filter((m) => m.compare !== null || m.union !== null);
}

function fill(template: string, w: Watched): string {
  return template
    .replace(/\{value\}/g, w.value)
    .replace(/\{enum\}/g, w.enumName ?? "matching");
}

// A project rule so enumDir files can be read through the project context, which also works on the in-memory file system.
const enumLiteralBypass: ProjectRule = {
  kind: "project",
  id: ENUM_ID,
  aliases: ["no-enum-literal-bypass"],
  description:
    "Raw enum value strings in comparisons, schemas or unions must use the enum.",
  check(ctx) {
    const matchers = buildMatchers(ctx);
    if (matchers.length === 0) return [];
    const prefilter = new RegExp(
      matchers.map((m) => escapeRegExp(m.value)).join("|")
    );
    const settings = settingsFor(ctx.config, enumLiteralBypass);
    const firstOnly = option<string>(ctx, "report", "each") === "first";
    const custom = option<string | undefined>(ctx, "message", undefined);
    const compareTemplate =
      custom ??
      'Raw enum literal "{value}", use the {enum} enum member instead';
    const unionTemplate =
      option<string | undefined>(ctx, "unionMessage", undefined) ??
      custom ??
      'Enum value "{value}" in a string-literal union, use the {enum} enum type instead';
    const found: Violation[] = [];

    for (const file of ctx.files) {
      if (!appliesTo(ctx.config, settings, undefined, file.path)) continue;
      file.lines.forEach((line, index) => {
        if (isCommentLine(line) || !prefilter.test(line)) return;
        const hits: { at: number; message: string }[] = [];
        for (const m of matchers) {
          if (!m.compare || !line.includes(m.value)) continue;
          const at = m.compare.exec(line)?.index;
          if (at !== undefined)
            hits.push({ at, message: fill(compareTemplate, m) });
        }
        for (const m of matchers) {
          if (!m.union || !line.includes(m.value)) continue;
          const at = m.union.exec(line)?.index;
          if (at !== undefined)
            hits.push({ at, message: fill(unionTemplate, m) });
        }
        const chosen =
          firstOnly && hits.length > 1
            ? [hits.reduce((a, b) => (b.at < a.at ? b : a))]
            : hits;
        for (const hit of chosen)
          found.push(violation(file.path, index + 1, ENUM_ID, hit.message));
      });
    }
    return found;
  },
};

export const RULES: Rule[] = [
  noRawThrow,
  noUnsafeErrorCast,
  errRequiresErrorCode,
  noEmptyCatch,
  noAny,
  typesInTypesFolder,
  enumLiteralBypass,
  requireExportJsdoc,
];
