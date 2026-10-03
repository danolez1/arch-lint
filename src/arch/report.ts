import type { Comparison, Violation } from "./types";

const location = (v: Violation) =>
  v.line > 0 ? `${v.file}:${v.line}` : v.file;

export function report(
  result: Comparison,
  total: number,
  showAll: Violation[] | null,
  scanned: number
): number {
  const lines: string[] = [
    `Architecture lint: scanned ${scanned} source files`,
  ];
  const byRule = new Map<string, Violation[]>();
  for (const v of result.fresh)
    byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);

  for (const [rule, items] of byRule) {
    lines.push(`\n${rule} (${items.length})`);
    for (const v of items) lines.push(`  ${location(v)}  ${v.message}`);
  }

  if (showAll) {
    const counts = new Map<string, number>();
    for (const v of showAll) counts.set(v.rule, (counts.get(v.rule) ?? 0) + 1);
    lines.push("\nAll current violations by rule (baselined debt included):");
    for (const [rule, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(count).padStart(5)}  ${rule}`);
    }
  }

  lines.push(
    `\n${total} violation(s) found: ${result.fresh.length} new, ${result.debt} baselined debt.`
  );
  if (result.fixed > 0) {
    lines.push(
      `${result.fixed} baselined violation(s) no longer occur; run "arch-lint arch --update-baseline" to lock the gain in.`
    );
  }
  lines.push(
    result.fresh.length > 0
      ? "Architecture lint failed."
      : "Architecture lint passed."
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.fresh.length > 0 ? 1 : 0;
}
