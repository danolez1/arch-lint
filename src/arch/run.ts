import { appliesTo, inLayer, levelFor, settingsFor } from "./config";
import { collectSources, type FileSystem } from "./files";
import { REGISTRY } from "./registry";
import type {
  FileRule,
  ProjectContext,
  ProjectRule,
  ResolvedConfig,
  Rule,
  RuleContext,
  Violation,
} from "./types";

function ruleContext(
  root: string,
  config: ResolvedConfig,
  rule: Rule
): RuleContext {
  return {
    root,
    config,
    options: settingsFor(config, rule).options ?? {},
    inLayer: (path, layer) => inLayer(config, path, layer),
    hasLayer: (layer) => config.layers[layer] !== undefined,
  };
}

export interface RunInput {
  root: string;
  config: ResolvedConfig;
  fs: FileSystem;
  /** Restrict to these rule ids or aliases. */
  only?: string[];
  rules?: Rule[];
}

export interface RunResult {
  violations: Violation[];
  scanned: number;
}

function wanted(rule: Rule, only: string[] | undefined): boolean {
  return (
    !only ||
    only.length === 0 ||
    only.some((id) => id === rule.id || rule.aliases?.includes(id))
  );
}

export async function runRules(input: RunInput): Promise<RunResult> {
  const { root, config, fs } = input;
  const rules = (input.rules ?? REGISTRY).filter(
    (r) => wanted(r, input.only) && levelFor(config, r) !== "off"
  );
  const files = collectSources(fs, config);
  const violations: Violation[] = [];

  for (const rule of rules.filter((r): r is FileRule => r.kind === "file")) {
    const settings = settingsFor(config, rule);
    const ctx = ruleContext(root, config, rule);
    for (const file of files) {
      if (!appliesTo(config, settings, rule.defaultLayer, file.path)) continue;
      violations.push(...rule.check(file, ctx));
    }
  }

  const projectContext = (rule: Rule): ProjectContext => ({
    ...ruleContext(root, config, rule),
    files,
    layer: settingsFor(config, rule).layer,
    listFiles: (extensions) =>
      fs
        .list()
        .filter((p) => !extensions || extensions.some((e) => p.endsWith(e))),
    read: (p) => fs.read(p),
  });
  for (const rule of rules.filter(
    (r): r is ProjectRule => r.kind === "project"
  )) {
    const settings = settingsFor(config, rule);
    for (const v of await rule.check(projectContext(rule))) {
      if (!appliesTo(config, settings, rule.defaultLayer, v.file)) continue;
      violations.push(v);
    }
  }

  violations.sort((a, b) =>
    `${a.file}:${String(a.line).padStart(6, "0")}:${a.rule}`.localeCompare(
      `${b.file}:${String(b.line).padStart(6, "0")}:${b.rule}`
    )
  );
  return { violations, scanned: files.length };
}
