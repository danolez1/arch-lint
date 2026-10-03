import { isCommentLine } from "../source";
import type {
  FileRule,
  ProjectRule,
  RuleContext,
  SourceFile,
  Violation,
} from "../types";

export function violation(
  file: string,
  line: number,
  rule: string,
  message: string
): Violation {
  return { file, line, rule, message };
}

export function option<T>(ctx: RuleContext, key: string, fallback: T): T {
  const value = ctx.options[key];
  return value === undefined ? fallback : (value as T);
}

export function messageFor(ctx: RuleContext, fallback: string): string {
  return option<string>(ctx, "message", fallback);
}

export interface PatternSpec {
  id: string;
  aliases?: string[];
  description: string;
  defaultLayer?: string;
  defaultLevel?: FileRule["defaultLevel"];
  pattern: RegExp;
  message: string;
  appliesTo?: (file: SourceFile, ctx: RuleContext) => boolean;
  /** Skip import and export-from lines. */
  skipImports?: boolean;
}

export function patternRule(spec: PatternSpec): FileRule {
  return {
    kind: "file",
    id: spec.id,
    aliases: spec.aliases,
    description: spec.description,
    defaultLayer: spec.defaultLayer,
    defaultLevel: spec.defaultLevel,
    check(file, ctx) {
      if (spec.appliesTo && !spec.appliesTo(file, ctx)) return [];
      const message = messageFor(ctx, spec.message);
      const found: Violation[] = [];
      file.lines.forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (spec.skipImports && /^\s*(import|export)\s.*from\s/.test(line))
          return;
        if (spec.pattern.test(line))
          found.push(violation(file.path, index + 1, spec.id, message));
      });
      return found;
    },
  };
}

export type { FileRule, ProjectRule };
