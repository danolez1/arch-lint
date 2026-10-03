import { mergeConfigs, resolveConfig } from "../../src/arch/config";
import { memoryFileSystem } from "../../src/arch/files";
import { findRule } from "../../src/arch/registry";
import { runRules } from "../../src/arch/run";
import type { Config, Violation } from "../../src/arch/types";

export interface CheckOptions {
  options?: Record<string, unknown>;
  config?: Config;
  settings?: {
    layer?: string;
    include?: string[];
    exempt?: { files?: string[]; dirs?: string[] };
  };
  /** Other files in the in-memory project, for rules that look across files. */
  files?: Record<string, string>;
}

// Goes through runRules, not rule.check, so layers, include and exemptions are applied as in a real run.
export async function check(
  ruleId: string,
  path: string,
  text: string,
  opts: CheckOptions = {}
): Promise<Violation[]> {
  return checkProject(ruleId, { ...opts.files, [path]: text }, opts);
}

export async function checkProject(
  ruleId: string,
  files: Record<string, string>,
  opts: CheckOptions = {}
): Promise<Violation[]> {
  const rule = findRule(ruleId);
  if (!rule) throw new Error(`Unknown rule ${ruleId}`);
  const config = resolveConfig(
    mergeConfigs(opts.config ?? {}, {
      rules: {
        [rule.id]: { level: "error", options: opts.options, ...opts.settings },
      },
    })
  );
  const { violations } = await runRules({
    root: "/virtual",
    config,
    fs: memoryFileSystem(files),
    only: [rule.id],
  });
  return violations;
}
