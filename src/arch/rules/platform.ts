import { dirname, join, normalize } from "node:path/posix";
import { importsOf, isCommentLine } from "../source";
import type {
  FileRule,
  Rule,
  RuleContext,
  SourceFile,
  Violation,
} from "../types";
import { messageFor, option, patternRule, violation } from "./util";

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A misconfigured option falls back to the default instead of crashing the run. */
function strings(ctx: RuleContext, key: string, fallback: string[]): string[] {
  const value = ctx.options[key];
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : fallback;
}

/** ctx.inLayer treats an undefined layer as everything, which would make an exemption swallow every file. */
function inDefinedLayer(
  ctx: RuleContext,
  path: string,
  layer: string
): boolean {
  return ctx.config.layers[layer] !== undefined && ctx.inLayer(path, layer);
}

interface LineSpec {
  id: string;
  aliases?: string[];
  description: string;
  defaultLayer?: string;
  skipImports?: boolean;
  /** Null when the rule has nothing to look for in this file. */
  matcher(
    file: SourceFile,
    ctx: RuleContext
  ): { pattern: RegExp; message: string } | null;
}

/** Like patternRule, for rules whose pattern is built from options. */
function lineRule(spec: LineSpec): FileRule {
  return {
    kind: "file",
    id: spec.id,
    aliases: spec.aliases,
    description: spec.description,
    defaultLayer: spec.defaultLayer,
    check(file, ctx) {
      const found = spec.matcher(file, ctx);
      if (!found) return [];
      const message = messageFor(ctx, found.message);
      const hits: Violation[] = [];
      file.lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (spec.skipImports && /^\s*(import|export)\s.*from\s/.test(line))
          return;
        if (found.pattern.test(line))
          hits.push(violation(file.path, index + 1, spec.id, message));
      });
      return hits;
    },
  };
}

const PROCESS_ENV_ANY = /\bprocess\.env\b/;
const PROCESS_ENV_MEMBER = /\bprocess\.env[.[]/;

const noRawProcessEnv = lineRule({
  id: "no-raw-process-env",
  description:
    "Configuration is read through a validated env helper, never from process.env directly. Options: memberAccessOnly, exemptLayers.",
  matcher(file, ctx) {
    const skip = strings(ctx, "exemptLayers", []);
    if (skip.some((layer) => inDefinedLayer(ctx, file.path, layer)))
      return null;
    // A bare `process.env` (spread, alias) leaks the whole environment, so it is flagged unless the project opts out.
    const memberOnly = option<boolean>(ctx, "memberAccessOnly", false);
    return {
      pattern: memberOnly ? PROCESS_ENV_MEMBER : PROCESS_ENV_ANY,
      message:
        "Read configuration through the validated env helper, not process.env",
    };
  },
});

const CONSOLE_METHODS = ["log", "warn", "error", "info", "debug"];

function consoleMethodsFor(file: SourceFile, ctx: RuleContext): string[] {
  const perLayer = option<Record<string, string[]>>(ctx, "layerMethods", {});
  for (const [layer, methods] of Object.entries(perLayer)) {
    if (inDefinedLayer(ctx, file.path, layer)) return methods;
  }
  return strings(ctx, "methods", CONSOLE_METHODS);
}

function consolePattern(methods: string[]): RegExp | null {
  const names = methods.filter((m) => /^\w+$/.test(m));
  return names.length === 0
    ? null
    : new RegExp(`\\bconsole\\.(${names.map(escapeRegExp).join("|")})\\s*\\(`);
}

const noConsole = lineRule({
  id: "no-console",
  aliases: ["no-console-log"],
  description:
    "Console output is replaced by the project logger. Options: methods, layerMethods (layer name to method list, first matching layer wins).",
  matcher(file, ctx) {
    const pattern = consolePattern(consoleMethodsFor(file, ctx));
    return (
      pattern && {
        pattern,
        message: "Use the project logger instead of console output",
      }
    );
  },
});

const phiRedactionRequired = lineRule({
  id: "phi-redaction-required",
  description:
    "Raw console calls bypass clinical data redaction in code that may handle patient data. Options: methods. Scoped to the clinical layer when the config defines one.",
  defaultLayer: "clinical",
  matcher(_file, ctx) {
    const pattern = consolePattern(
      strings(ctx, "methods", [...CONSOLE_METHODS, "trace"])
    );
    return (
      pattern && {
        pattern,
        message:
          "Raw console output bypasses clinical data redaction; use the logger that wraps the redacting sink",
      }
    );
  },
});

const FETCH_CALL =
  /(?:^|[^\w$.])(?:(?:globalThis|window|global|self)\.)?fetch\s*\(/;

type FetchScope = "all" | "tsx" | "non-tsx";

const noRawFetch = patternRule({
  id: "no-raw-fetch",
  description:
    "Network calls go through the shared HTTP client, never a bare fetch. Options: scope (all, tsx or non-tsx). Method calls named fetch are not flagged.",
  pattern: FETCH_CALL,
  message: "Use the shared HTTP client instead of a raw fetch call",
  skipImports: true,
  appliesTo(file, ctx) {
    const scope = option<FetchScope>(ctx, "scope", "all");
    return scope === "all" || (scope === "tsx") === file.isTsx;
  },
});

// Kept apart from no-raw-fetch because components get a different fix (go through a store) and a different exemption list.
const noRawFetchInComponents = patternRule({
  id: "no-raw-fetch-in-components",
  description:
    "Component files (.tsx) do not call fetch themselves; data comes through a store or service.",
  pattern: FETCH_CALL,
  message:
    "Components must not call fetch directly; go through a store or service",
  skipImports: true,
  appliesTo: (file) => file.isTsx,
});

const REQUIRE_AXIOS = /\brequire\s*\(\s*["']axios["']\s*\)/;

const noAxios: FileRule = {
  kind: "file",
  id: "no-axios",
  description:
    "axios is not used; the shared HTTP client replaces it. Options: allowTypeImports (default false). Covers import, export from, dynamic import and require.",
  check(file, ctx) {
    const allowTypes = option<boolean>(ctx, "allowTypeImports", false);
    const message = messageFor(
      ctx,
      "Use the shared HTTP client instead of axios"
    );
    const found = importsOf(file)
      .filter((ref) => ref.source === "axios" && !(allowTypes && ref.typeOnly))
      .map((ref) => violation(file.path, ref.line, "no-axios", message));
    file.code.split("\n").forEach((line, index) => {
      if (REQUIRE_AXIOS.test(line))
        found.push(violation(file.path, index + 1, "no-axios", message));
    });
    return found;
  },
};

const ROUTE_ARGUMENT = String.raw`\(\s*["'\`]\/`;

const noMagicPath = lineRule({
  id: "no-magic-path",
  description:
    "Route strings come from a shared paths module. Flags a literal starting with / in href, router push/replace/prefetch, redirect and client calls. Options: clients (names whose get, post, put, patch and delete calls are checked).",
  matcher(_file, ctx) {
    const clients = strings(ctx, "clients", ["apiClient"])
      .map(escapeRegExp)
      .join("|");
    const parts = [
      String.raw`\bhref\s*=\s*\{?\s*["'\`]\/`,
      String.raw`\b(?:router|Router)\.(?:push|replace|prefetch)${ROUTE_ARGUMENT}`,
      String.raw`\b(?:redirect|permanentRedirect)${ROUTE_ARGUMENT}`,
    ];
    if (clients)
      parts.push(
        String.raw`\b(?:${clients})\.(?:get|post|put|patch|delete)${ROUTE_ARGUMENT}`
      );
    return {
      pattern: new RegExp(parts.join("|")),
      message: "Hardcoded route string; import it from the shared paths module",
    };
  },
});

const DEFAULT_WORKSPACE_ROOTS = [
  "apps",
  "packages",
  "plugins",
  "services",
  "tools",
];
const RELATIVE_FROM = /from\s+["'](\.\.\/[^"']+)["']/;

const noRelativeCrossPackage: FileRule = {
  kind: "file",
  id: "no-relative-cross-package",
  description:
    "Imports that leave a workspace use its package name, not a relative path. A workspace is the first two path segments under one of workspaceRoots.",
  check(file, ctx) {
    const roots = new Set(
      strings(ctx, "workspaceRoots", DEFAULT_WORKSPACE_ROOTS)
    );
    const message = messageFor(
      ctx,
      "Import across workspaces through the package name, not a relative path"
    );
    const [sourceRoot, sourceWorkspace] = normalize(file.path).split("/");
    if (!roots.has(sourceRoot ?? "")) return [];
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      const specifier = line.match(RELATIVE_FROM)?.[1];
      if (!specifier) return;
      const [targetRoot, targetWorkspace] = normalize(
        join(dirname(file.path), specifier)
      ).split("/");
      const crosses =
        roots.has(targetRoot ?? "") &&
        (sourceRoot !== targetRoot || sourceWorkspace !== targetWorkspace);
      if (crosses)
        found.push(
          violation(file.path, index + 1, "no-relative-cross-package", message)
        );
    });
    return found;
  },
};

const underPrefix = (source: string, prefixes: string[]): boolean =>
  prefixes.some(
    (prefix) => source === prefix || source.startsWith(`${prefix}/`)
  );

const noServiceInTsx: FileRule = {
  kind: "file",
  id: "no-service-in-tsx",
  description:
    "Component files (.tsx) stay view-only and reach services through a store action. Options: servicePaths (import prefixes banned in every .tsx), clientOnlyServicePaths (banned only in files that start with a use client directive). Type-only imports are allowed.",
  check(file, ctx) {
    if (!file.isTsx) return [];
    const always = strings(ctx, "servicePaths", ["@/lib/services"]);
    // A server component is the server-side caller, so these only bind client code.
    const clientOnly = strings(ctx, "clientOnlyServicePaths", [
      "@/lib/server/services",
    ]);
    const message = (source: string) =>
      messageFor(
        ctx,
        `Components are view-only; reach ${source} through a store action instead`
      );
    return importsOf(file)
      .filter((ref) => !ref.typeOnly)
      .filter(
        (ref) =>
          underPrefix(ref.source, always) ||
          (file.isClient && underPrefix(ref.source, clientOnly))
      )
      .map((ref) =>
        violation(file.path, ref.line, "no-service-in-tsx", message(ref.source))
      );
  },
};

const DATE_CHECKS: Record<string, string> = {
  "locale-date-time": String.raw`\.toLocale(?:Date|Time)String\s*\(`,
  "locale-string-any": String.raw`\.toLocaleString\s*\(`,
  // Bare toLocaleString also formats numbers, so only date-named receivers count.
  "locale-string-date-named": String.raw`\b\w*(?:[dD]ate|[tT]ime|[aA]t)\w*\.toLocaleString\s*\(`,
  getters: String.raw`\.getU?T?C?(?:Month|FullYear|Date|Day|Hours|Minutes|Seconds)\s*\(`,
  setters: String.raw`\.set(?:U?T?C?)(?:Date|Month|FullYear|Hours|Minutes|Seconds)\s*\(`,
  "iso-split": String.raw`\.toISOString\(\)\.split\(`,
  "new-date-get-time": String.raw`new Date\([^)]*\)\.getTime\(`,
  "ms-arithmetic": String.raw`\*\s*60\s*\*\s*1000|\*\s*1000\s*\*\s*60|1000\s*\*\s*60\s*\*\s*60`,
};

const DATE_VARIANTS: Record<string, string[]> = {
  strict: [
    "locale-date-time",
    "locale-string-date-named",
    "getters",
    "setters",
    "iso-split",
    "new-date-get-time",
    "ms-arithmetic",
  ],
  basic: ["locale-date-time", "locale-string-any", "getters"],
};

function dateChecksFor(ctx: RuleContext): string[] {
  const explicit = ctx.options["checks"];
  if (Array.isArray(explicit)) return explicit.map(String);
  const variant = option<string>(ctx, "variant", "strict");
  const named = DATE_VARIANTS[variant];
  if (!named) throw new Error(`no-date-methods: unknown variant "${variant}"`);
  return named;
}

const noDateMethods = lineRule({
  id: "no-date-methods",
  description: `Dates go through a date library, not raw Date methods or millisecond arithmetic. Options: variant (strict or basic, default strict) or checks, a list of ${Object.keys(DATE_CHECKS).join(", ")}. A checks list replaces the variant.`,
  matcher(_file, ctx) {
    const sources = dateChecksFor(ctx).map((name) => {
      const source = DATE_CHECKS[name];
      if (!source) throw new Error(`no-date-methods: unknown check "${name}"`);
      return source;
    });
    if (sources.length === 0) return null;
    return {
      pattern: new RegExp(sources.join("|")),
      message:
        "Use the date library instead of raw Date methods and manual millisecond arithmetic",
    };
  },
});

export const RULES: Rule[] = [
  noRawProcessEnv,
  noConsole,
  noRawFetch,
  noRawFetchInComponents,
  noAxios,
  noMagicPath,
  noRelativeCrossPackage,
  noServiceInTsx,
  noDateMethods,
  phiRedactionRequired,
];
