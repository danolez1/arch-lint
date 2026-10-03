import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { matchesAny, matchesPattern } from "./paths";
import type {
  Config,
  Level,
  ResolvedConfig,
  Rule,
  RuleSettings,
} from "./types";

export const CONFIG_FILE = "arch-lint.config.json";
const PRESET_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../presets"
);

const ALWAYS_IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.codeflow/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
];

const DEFAULT_TESTS = [
  "**/tests/**",
  "**/test/**",
  "**/*.test.*",
  "**/*.spec.*",
];

function toSettings(value: Level | RuleSettings | undefined): RuleSettings {
  if (value === undefined) return {};
  return typeof value === "string" ? { level: value } : { ...value };
}

function mergeSettings(base: RuleSettings, over: RuleSettings): RuleSettings {
  return {
    ...base,
    ...over,
    include: over.include ?? base.include,
    exempt: {
      files: [...(base.exempt?.files ?? []), ...(over.exempt?.files ?? [])],
      dirs: [...(base.exempt?.dirs ?? []), ...(over.exempt?.dirs ?? [])],
    },
    options: { ...base.options, ...over.options },
  };
}

/** Later configs win per key. Exemptions accumulate and layers replace by name. */
export function mergeConfigs(base: Config, over: Config): Config {
  const rules: Record<string, RuleSettings> = {};
  for (const [id, value] of Object.entries(base.rules ?? {}))
    rules[id] = toSettings(value);
  for (const [id, value] of Object.entries(over.rules ?? {})) {
    rules[id] = mergeSettings(rules[id] ?? {}, toSettings(value));
  }
  return {
    scan: over.scan ?? base.scan,
    ignore: [...(base.ignore ?? []), ...(over.ignore ?? [])],
    tests: over.tests ?? base.tests,
    layers: { ...base.layers, ...over.layers },
    rules,
    defaultLevel: over.defaultLevel ?? base.defaultLevel,
    baseline: over.baseline ?? base.baseline,
    migrations: { ...base.migrations, ...over.migrations },
  };
}

function readJson(file: string): Config {
  return JSON.parse(readFileSync(file, "utf8")) as Config;
}

function resolveExtends(ref: string, from: string): string {
  if (ref.startsWith("preset:")) {
    const file = path.join(PRESET_DIR, `${ref.slice("preset:".length)}.json`);
    if (!existsSync(file))
      throw new Error(`Unknown preset "${ref}" (looked for ${file})`);
    return file;
  }
  return path.resolve(path.dirname(from), ref);
}

function load(file: string, seen: Set<string>): Config {
  if (seen.has(file)) throw new Error(`Circular "extends" through ${file}`);
  seen.add(file);
  const config = readJson(file);
  let merged: Config = {};
  for (const ref of config.extends ?? []) {
    merged = mergeConfigs(merged, load(resolveExtends(ref, file), seen));
  }
  seen.delete(file);
  return mergeConfigs(merged, config);
}

/** A project without a config file gets the recommended preset. */
export function loadConfig(root: string, explicit?: string): Config {
  const file = explicit
    ? path.resolve(root, explicit)
    : path.join(root, CONFIG_FILE);
  if (explicit && !existsSync(file))
    throw new Error(`Config file not found: ${file}`);
  if (existsSync(file)) return load(file, new Set());
  return load(resolveExtends("preset:recommended", file), new Set());
}

export function resolveConfig(config: Config): ResolvedConfig {
  const rules: Record<string, RuleSettings> = {};
  for (const [id, value] of Object.entries(config.rules ?? {}))
    rules[id] = toSettings(value);
  return {
    scan: config.scan ?? ["."],
    ignore: [...ALWAYS_IGNORED, ...(config.ignore ?? [])],
    tests: config.tests ?? DEFAULT_TESTS,
    layers: config.layers ?? {},
    defaultLevel: config.defaultLevel,
    rules,
    baseline: config.baseline ?? "arch-lint.baseline.json",
    migrations: {
      dir: config.migrations?.dir ?? "drizzle",
      journal: config.migrations?.journal ?? "drizzle/meta/_journal.json",
      releaseRef: config.migrations?.releaseRef ?? "refs/heads/main",
      baseRef: config.migrations?.baseRef ?? "origin/main",
      explicit: {
        dir: config.migrations?.dir !== undefined,
        journal: config.migrations?.journal !== undefined,
      },
    },
  };
}

/** Settings for a rule, merged from its aliases and then its own id, which wins. */
export function settingsFor(config: ResolvedConfig, rule: Rule): RuleSettings {
  let merged: RuleSettings | undefined;
  for (const id of [...(rule.aliases ?? []), rule.id]) {
    const found = config.rules[id];
    if (found) merged = merged ? mergeSettings(merged, found) : found;
  }
  return merged ?? {};
}

export function levelFor(config: ResolvedConfig, rule: Rule): Level {
  return (
    settingsFor(config, rule).level ??
    config.defaultLevel ??
    rule.defaultLevel ??
    "error"
  );
}

/** A layer that the config never defined matches every path. */
export function inLayer(
  config: ResolvedConfig,
  file: string,
  layer: string | undefined
): boolean {
  if (!layer) return true;
  const patterns = config.layers[layer];
  return patterns === undefined ? true : matchesAny(file, patterns);
}

export function isExempt(settings: RuleSettings, file: string): boolean {
  return (
    (settings.exempt?.files?.some((entry) => matchesPattern(file, entry)) ??
      false) ||
    (settings.exempt?.dirs?.some((dir) => file.startsWith(dir)) ?? false)
  );
}

export function appliesTo(
  config: ResolvedConfig,
  settings: RuleSettings,
  defaultLayer: string | undefined,
  file: string
): boolean {
  if (!inLayer(config, file, settings.layer ?? defaultLayer)) return false;
  if (settings.include && !matchesAny(file, settings.include)) return false;
  return !isExempt(settings, file);
}
