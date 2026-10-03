import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Baseline, Comparison, Violation } from "./types";

const key = (rule: string, file: string) => `${rule}::${file}`;

export function countByKey(
  violations: Violation[],
  canonical: (id: string) => string = (id) => id
): Baseline {
  const counts: Baseline = {};
  for (const v of violations) {
    const k = key(canonical(v.rule), v.file);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// Baselines written under an older rule id must keep matching after a rename.
export function canonicalizeBaseline(
  baseline: Baseline,
  canonical: (id: string) => string
): Baseline {
  const out: Baseline = {};
  for (const [k, count] of Object.entries(baseline)) {
    const [rule = "", ...rest] = k.split("::");
    const next = key(canonical(rule), rest.join("::"));
    out[next] = (out[next] ?? 0) + count;
  }
  return out;
}

export function readBaseline(root: string, file: string): Baseline {
  const full = path.join(root, file);
  return existsSync(full)
    ? (JSON.parse(readFileSync(full, "utf8")) as Baseline)
    : {};
}

export function writeBaseline(
  root: string,
  file: string,
  violations: Violation[],
  canonical: (id: string) => string = (id) => id
): number {
  const sorted = Object.fromEntries(
    Object.entries(countByKey(violations, canonical)).sort(([a], [b]) =>
      a.localeCompare(b)
    )
  );
  writeFileSync(path.join(root, file), `${JSON.stringify(sorted, null, 2)}\n`);
  return Object.keys(sorted).length;
}

export function compareToBaseline(
  violations: Violation[],
  baseline: Baseline,
  canonical: (id: string) => string = (id) => id
): Comparison {
  const seen: Baseline = {};
  const fresh: Violation[] = [];
  let debt = 0;
  for (const v of violations) {
    const k = key(canonical(v.rule), v.file);
    seen[k] = (seen[k] ?? 0) + 1;
    if (seen[k] <= (baseline[k] ?? 0)) debt++;
    else fresh.push(v);
  }
  const fixed = Object.entries(baseline).reduce(
    (sum, [k, allowed]) => sum + Math.max(0, allowed - (seen[k] ?? 0)),
    0
  );
  return { fresh, debt, fixed };
}
