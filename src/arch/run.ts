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

// A project that still configures an older id sees that id in the output, so its CI greps and logs keep matching.
function reportedId(config: ResolvedConfig, rule: Rule): string {
  if (config.rules[rule.id]) return rule.id;
  return rule.aliases?.find((alias) => config.rules[alias]) ?? rule.id;
}

function rename(
  violations: Violation[],
  from: string,
  to: string
): Violation[] {
  return from === to
    ? violations
    : violations.map((v) => (v.rule === from ? { ...v, rule: to } : v));
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
      violations.push(
        ...rename(rule.check(file, ctx), rule.id, reportedId(config, rule))
      );
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
    const checked = rename(
      await rule.check(projectContext(rule)),
      rule.id,
      reportedId(config, rule)
    );
    for (const v of checked) {
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
