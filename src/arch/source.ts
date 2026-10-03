import type { ImportRef, SourceFile } from "./types";

// Blanked rather than removed so offsets and line numbers still match the original text.
export function stripComments(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(
      /(^|[^:"'`\\])\/\/[^\n]*/g,
      (m, lead: string) => lead + blank(m.slice(lead.length))
    );
}

export function lineAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

export function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

export function buildSource(path: string, text: string): SourceFile {
  return {
    path,
    text,
    lines: text.split("\n"),
    code: stripComments(text),
    isTsx: path.endsWith(".tsx"),
    isClient: /^["']use client["']/.test(stripComments(text).trimStart()),
  };
}

// The clause may not cross another import/export keyword, a semicolon or a quote, so an `export const x = 1` cannot pair with a later `from`.
const IMPORT_STATEMENT =
  /\b(?:import|export)\s+(type\s+)?((?:(?!\b(?:import|export)\b)[^;'"`])*?)\s+from\s+["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["'](@\/[^"']+|[^"'.][^"']*)["']\s*\)/g;

export function importsOf(file: SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];
  for (const match of file.code.matchAll(IMPORT_STATEMENT)) {
    const clause = match[2] ?? "";
    const braced = clause.match(/\{([\s\S]*)\}/)?.[1];
    const specs =
      braced
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean) ?? [];
    const head = clause
      .replace(/\{[\s\S]*\}/, "")
      .replace(/,/g, "")
      .trim();
    const allTypeSpecs =
      specs.length > 0 && !head && specs.every((s) => s.startsWith("type "));
    refs.push({
      source: match[3] ?? "",
      line: lineAt(file.code, match.index ?? 0),
      typeOnly: Boolean(match[1]) || allTypeSpecs,
      names: [head, ...specs].filter(Boolean),
    });
  }
  for (const match of file.code.matchAll(DYNAMIC_IMPORT)) {
    refs.push({
      source: match[1] ?? "",
      line: lineAt(file.code, match.index ?? 0),
      typeOnly: false,
      names: [],
    });
  }
  return refs;
}
