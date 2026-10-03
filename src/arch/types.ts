export interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

export interface SourceFile {
  /** Path relative to the project root, forward slashes. */
  path: string;
  text: string;
  lines: string[];
  /** Text with comments blanked, offsets and newlines preserved. */
  code: string;
  isTsx: boolean;
  /** Starts with a "use client" directive. */
  isClient: boolean;
}

export interface ImportRef {
  source: string;
  line: number;
  /** Differs from `line` for a multi-line import. */
  fromLine: number;
  kind: "import" | "export-from" | "dynamic";
  typeOnly: boolean;
  names: string[];
}

export type Level = "error" | "off";

export interface RuleSettings {
  level?: Level;
  /** Named layer (see Config.layers) the rule is limited to. Unset means the rule's own default layer, else every scanned file. */
  layer?: string;
  /** Extra path patterns the rule is limited to, in addition to the layer. */
  include?: string[];
  exempt?: { files?: string[]; dirs?: string[] };
  /** Rule specific options, listed in docs/RULE-OPTIONS.md. */
  options?: Record<string, unknown>;
}

export interface Config {
  /** Presets to merge underneath this config, in order. Built-ins are written "preset:<name>". */
  extends?: string[];
  /** Directories, files or globs to scan. Default: ["."]. */
  scan?: string[];
  /** Path patterns skipped everywhere. node_modules and build output are always skipped. */
  ignore?: string[];
  /** Test file patterns. Source rules skip them. Default: tests/ and test/ directories, *.test.* and *.spec.*. */
  tests?: string[];
  /** Named groups of path patterns that rules can be limited to (backend, routes, models, components, ...). */
  layers?: Record<string, string[]>;
  /** Level for rules the config does not list. "off" runs only the listed rules. Default: each rule's own default. */
  defaultLevel?: Level;
  rules?: Record<string, Level | RuleSettings>;
  /** Violation counts allowed per rule and file. Default: arch-lint.baseline.json. */
  baseline?: string;
  migrations?: {
    dir?: string;
    journal?: string;
    releaseRef?: string;
    baseRef?: string;
  };
}

export interface ResolvedConfig {
  scan: string[];
  ignore: string[];
  tests: string[];
  layers: Record<string, string[]>;
  defaultLevel?: Level;
  rules: Record<string, RuleSettings>;
  baseline: string;
  migrations: {
    dir: string;
    journal: string;
    releaseRef: string;
    baseRef: string;
    explicit: { dir: boolean; journal: boolean };
  };
}

export interface RuleContext {
  root: string;
  config: ResolvedConfig;
  options: Record<string, unknown>;
  /** True when the path belongs to the named layer. An undefined layer matches everything. */
  inLayer(path: string, layer: string): boolean;
  /** True when the config defines the named layer (inLayer matches everything for an undefined one). */
  hasLayer(layer: string): boolean;
}

export interface FileRule {
  kind: "file";
  id: string;
  /** Older ids this rule answers to in configs and baselines. */
  aliases?: string[];
  description: string;
  /** Layer the rule is limited to unless the config says otherwise. */
  defaultLayer?: string;
  /** Rules that are off unless the config turns them on. */
  defaultLevel?: Level;
  check(file: SourceFile, ctx: RuleContext): Violation[];
}

export interface ProjectContext extends RuleContext {
  files: SourceFile[];
  layer?: string;
  /** Every non-ignored file path under the scan roots, not just source files. */
  listFiles(extensions?: string[]): string[];
  read(path: string): string | null;
}

export interface ProjectRule {
  kind: "project";
  id: string;
  aliases?: string[];
  description: string;
  /** Layer the rule is limited to unless the config says otherwise. */
  defaultLayer?: string;
  defaultLevel?: Level;
  check(ctx: ProjectContext): Violation[] | Promise<Violation[]>;
}

export type Rule = FileRule | ProjectRule;

export type Baseline = Record<string, number>;

export interface Comparison {
  fresh: Violation[];
  debt: number;
  fixed: number;
}
