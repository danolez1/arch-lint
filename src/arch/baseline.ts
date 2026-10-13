import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  Baseline,
  BaselineMode,
  Comparison,
  FindingBaseline,
  Violation,
  ViolationMetric,
} from "./types";

const key = (rule: string, file: string) => `${rule}::${file}`;
const isFindingBaseline = (value: Baseline): value is FindingBaseline =>
  "version" in value &&
  (value.version === 2 ||
    value.version === 3 ||
    value.version === 4 ||
    value.version === 5) &&
  Array.isArray(value.findings);

function fingerprintKeys(
  violations: Violation[],
  canonical: (id: string) => string,
  includeMessage = false,
  stableNonMetrics = false,
  scopeByRule = false
): string[] {
  return violations.map((violation) => {
    const rule = canonical(violation.rule);
    const stableIdentity = violation.baselineIdentity ?? violation.identity;
    const identity =
      stableIdentity ??
      (stableNonMetrics
        ? `${rule}\0${violation.file}`
        : `${rule}\0${violation.file}\0${violation.message}`);
    const scoped =
      scopeByRule && stableIdentity ? `${rule}\0${identity}` : identity;
    const stable =
      includeMessage &&
      !stableNonMetrics &&
      stableIdentity &&
      !violation.metrics
        ? `${scoped}\0${violation.message}`
        : scoped;
    return stable;
  });
}

function fingerprintId(stable: string, ordinal: number): string {
  return createHash("sha256").update(`${stable}\0${ordinal}`).digest("hex");
}

function fingerprintIds(keys: string[]): string[] {
  const occurrences = new Map<string, number>();
  return keys.map((stable) => {
    const ordinal = occurrences.get(stable) ?? 0;
    occurrences.set(stable, ordinal + 1);
    return fingerprintId(stable, ordinal);
  });
}

function fingerprints(
  violations: Violation[],
  canonical: (id: string) => string,
  includeMessage = false,
  stableNonMetrics = false,
  scopeByRule = false
): string[] {
  return fingerprintIds(
    fingerprintKeys(
      violations,
      canonical,
      includeMessage,
      stableNonMetrics,
      scopeByRule
    )
  );
}

function readMetrics(
  value: unknown,
  file: string
): Record<string, Record<string, ViolationMetric>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid architecture baseline metrics in ${file}`);
  const result: Record<string, Record<string, ViolationMetric>> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(
        `Invalid architecture baseline metrics for ${id} in ${file}`
      );
    const metrics: Record<string, ViolationMetric> = {};
    for (const [name, metric] of Object.entries(entry)) {
      const raw = metric as Record<string, unknown>;
      if (
        !metric ||
        typeof metric !== "object" ||
        Array.isArray(metric) ||
        typeof raw.value !== "number" ||
        !Number.isFinite(raw.value) ||
        (raw.worsening !== "higher" && raw.worsening !== "lower")
      )
        throw new Error(
          `Invalid architecture baseline metric ${name} for ${id} in ${file}`
        );
      metrics[name] = {
        value: raw.value as number,
        worsening: raw.worsening as ViolationMetric["worsening"],
      };
    }
    result[id] = metrics;
  }
  return result;
}

function metricWorsened(
  current: Record<string, ViolationMetric>,
  baseline: Record<string, ViolationMetric>
): boolean {
  return Object.entries(current).some(([name, metric]) => {
    const previous = baseline[name];
    return (
      !previous ||
      previous.worsening !== metric.worsening ||
      (metric.worsening === "higher"
        ? metric.value > previous.value
        : metric.value < previous.value)
    );
  });
}

function matchNonWorseningMetrics(
  current: Violation[],
  candidates: Array<{
    id: string;
    metrics?: Record<string, ViolationMetric>;
  }>
): Map<number, number> {
  const edges = current.map((finding) =>
    candidates.flatMap((candidate, index) =>
      metricWorsened(finding.metrics ?? {}, candidate.metrics ?? {})
        ? []
        : [index]
    )
  );
  const currentMatches = Array<number>(current.length).fill(-1);
  const candidateMatches = Array<number>(candidates.length).fill(-1);
  const distances = Array<number>(current.length).fill(
    Number.POSITIVE_INFINITY
  );

  function shortestAugmentingPath(): number | undefined {
    const queue: number[] = [];
    let shortest = Number.POSITIVE_INFINITY;
    for (const index of current.keys()) {
      if (currentMatches[index] === -1) {
        distances[index] = 0;
        queue.push(index);
      } else distances[index] = Number.POSITIVE_INFINITY;
    }

    for (let cursor = 0; cursor < queue.length; cursor++) {
      const currentIndex = queue[cursor]!;
      const nextDistance = distances[currentIndex]! + 1;
      if (nextDistance > shortest) continue;
      for (const candidateIndex of edges[currentIndex]!) {
        const matchedCurrent = candidateMatches[candidateIndex]!;
        if (matchedCurrent === -1) shortest = nextDistance;
        else if (
          nextDistance < shortest &&
          distances[matchedCurrent] === Number.POSITIVE_INFINITY
        ) {
          distances[matchedCurrent] = nextDistance;
          queue.push(matchedCurrent);
        }
      }
    }
    return Number.isFinite(shortest) ? shortest : undefined;
  }

  function augment(currentIndex: number, shortest: number): boolean {
    const nextDistance = distances[currentIndex]! + 1;
    for (const candidateIndex of edges[currentIndex]!) {
      const matchedCurrent = candidateMatches[candidateIndex]!;
      if (matchedCurrent === -1) {
        if (nextDistance !== shortest) continue;
      } else if (
        distances[matchedCurrent] !== nextDistance ||
        !augment(matchedCurrent, shortest)
      )
        continue;
      currentMatches[currentIndex] = candidateIndex;
      candidateMatches[candidateIndex] = currentIndex;
      return true;
    }
    distances[currentIndex] = Number.POSITIVE_INFINITY;
    return false;
  }

  let shortest = shortestAugmentingPath();
  while (shortest !== undefined) {
    for (const index of current.keys())
      if (currentMatches[index] === -1) augment(index, shortest);
    shortest = shortestAugmentingPath();
  }

  return new Map(
    currentMatches.flatMap((candidateIndex, currentIndex) =>
      candidateIndex === -1 ? [] : [[currentIndex, candidateIndex]]
    )
  );
}

function metricBaselineMatches(
  violations: Violation[],
  keys: string[],
  baseline: FindingBaseline
): {
  matched: Set<number>;
  fresh: Set<number>;
  used: Set<string>;
} {
  const groups = new Map<string, number[]>();
  for (const [index, stable] of keys.entries()) {
    const group = groups.get(stable);
    if (group) group.push(index);
    else groups.set(stable, [index]);
  }

  const matched = new Set<number>();
  const fresh = new Set<number>();
  const used = new Set<string>();
  const available = new Set(baseline.findings);
  for (const [stable, indices] of groups) {
    const candidates: Array<{
      id: string;
      metrics?: Record<string, ViolationMetric>;
    }> = [];
    for (let ordinal = 0; ordinal < baseline.findings.length; ordinal++) {
      const id = fingerprintId(stable, ordinal);
      if (!available.has(id)) break;
      candidates.push({ id, metrics: baseline.metrics?.[id] });
    }

    const current = indices.map((index) => violations[index]!);
    const nonWorsening = matchNonWorseningMetrics(current, candidates);
    const matchedCandidates = new Set<number>();
    for (const [currentIndex, candidateIndex] of nonWorsening) {
      const globalIndex = indices[currentIndex]!;
      const candidate = candidates[candidateIndex]!;
      matched.add(globalIndex);
      matchedCandidates.add(candidateIndex);
      used.add(candidate.id);
    }

    const remainingCurrent = [...current.keys()].filter(
      (index) => !nonWorsening.has(index)
    );
    const remainingCandidates = [...candidates.keys()].filter(
      (index) => !matchedCandidates.has(index)
    );
    let nextCandidate = 0;
    for (const currentIndex of remainingCurrent) {
      const candidateIndex = remainingCandidates[nextCandidate++];
      const globalIndex = indices[currentIndex]!;
      if (candidateIndex === undefined) continue;
      const candidate = candidates[candidateIndex]!;
      matched.add(globalIndex);
      used.add(candidate.id);
      fresh.add(globalIndex);
    }
  }
  return { matched, fresh, used };
}

export function countByKey(
  violations: Violation[],
  canonical: (id: string) => string = (id) => id
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const v of violations) {
    const k = key(canonical(v.rule), v.file);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

export function canonicalizeBaseline(
  baseline: Baseline,
  canonical: (id: string) => string
): Baseline {
  if (isFindingBaseline(baseline)) {
    const legacy: Record<string, number> = {};
    for (const [entry, count] of Object.entries(baseline.legacy)) {
      const [rule = "", ...rest] = entry.split("::");
      const next = key(canonical(rule), rest.join("::"));
      legacy[next] = (legacy[next] ?? 0) + count;
    }
    return { ...baseline, legacy };
  }
  const legacy: Record<string, number> = {};
  for (const [entry, count] of Object.entries(baseline)) {
    const [rule = "", ...rest] = entry.split("::");
    const next = key(canonical(rule), rest.join("::"));
    legacy[next] = (legacy[next] ?? 0) + count;
  }
  return { version: 2, findings: [], legacy };
}

export function readBaseline(root: string, file: string): Baseline {
  const full = path.join(root, file);
  if (!existsSync(full)) return { version: 2, findings: [], legacy: {} };
  const data: unknown = JSON.parse(readFileSync(full, "utf8"));
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error(`Invalid architecture baseline: ${full}`);
  const value = data as Record<string, unknown>;
  if (
    (value.version === 2 ||
      value.version === 3 ||
      value.version === 4 ||
      value.version === 5) &&
    Array.isArray(value.findings)
  ) {
    if (
      value.version === 5 &&
      value.mode !== "identity" &&
      value.mode !== "worsening"
    )
      throw new Error(`Invalid architecture baseline mode in ${full}`);
    const legacy =
      value.legacy &&
      typeof value.legacy === "object" &&
      !Array.isArray(value.legacy)
        ? (value.legacy as Record<string, unknown>)
        : {};
    for (const [entry, count] of Object.entries(legacy)) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
        throw new Error(
          `Invalid legacy architecture baseline entry "${entry}" in ${full}`
        );
    }
    return {
      version: value.version,
      ...(value.version === 5 ? { mode: value.mode as BaselineMode } : {}),
      findings: value.findings.filter(
        (entry): entry is string => typeof entry === "string"
      ),
      legacy: legacy as Record<string, number>,
      ...(value.version === 4 ||
      (value.version === 5 && value.mode === "worsening")
        ? { metrics: readMetrics(value.metrics, full) }
        : {}),
    };
  }
  const legacy: Record<string, number> = {};
  for (const [entry, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
      throw new Error(
        `Invalid legacy architecture baseline entry "${entry}" in ${full}`
      );
    legacy[entry] = count;
  }
  return { version: 2, findings: [], legacy };
}

export function writeBaseline(
  root: string,
  file: string,
  violations: Violation[],
  canonical: (id: string) => string = (id) => id,
  mode: BaselineMode = "identity"
): number {
  const ids = fingerprints(
    violations,
    canonical,
    mode === "worsening",
    mode === "worsening",
    true
  );
  const metrics = Object.fromEntries(
    violations.flatMap((violation, index) =>
      violation.metrics ? [[ids[index]!, violation.metrics]] : []
    )
  );
  const baseline: FindingBaseline = {
    version: 5,
    mode,
    findings: [...ids].sort(),
    legacy: {},
    ...(mode === "worsening" ? { metrics } : {}),
  };
  writeFileSync(
    path.join(root, file),
    `${JSON.stringify(baseline, null, 2)}\n`
  );
  return new Set(violations.map((v) => key(canonical(v.rule), v.file))).size;
}

export function assertBaselineMode(
  baseline: Baseline,
  mode: BaselineMode
): void {
  const populated = isFindingBaseline(baseline)
    ? baseline.findings.length > 0 ||
      Object.values(baseline.legacy).some((count) => count > 0)
    : Object.values(baseline).some((count) => count > 0);
  let compatible = mode === "identity";
  if (isFindingBaseline(baseline)) {
    if (mode === "worsening")
      compatible = baseline.version === 5 && baseline.mode === "worsening";
    else
      compatible =
        baseline.version === 2 ||
        baseline.version === 3 ||
        (baseline.version === 5 && baseline.mode === "identity");
  }
  const incompatible = !compatible;
  if (populated && incompatible)
    throw new Error(
      `baselineMode "${mode}" requires a refreshed baseline; run "arch-lint arch --update-baseline" to refresh it`
    );
}

export function compareToBaseline(
  violations: Violation[],
  baseline: Baseline,
  canonical: (id: string) => string = (id) => id
): Comparison {
  const normalized = isFindingBaseline(baseline)
    ? baseline
    : (canonicalizeBaseline(baseline, canonical) as FindingBaseline);
  const available = new Set(normalized.findings);
  const legacySeen: Record<string, number> = {};
  const used = new Set<string>();
  const fresh: Violation[] = [];
  const metricMode =
    normalized.version === 4 ||
    (normalized.version === 5 && normalized.mode === "worsening");
  const stableKeys = fingerprintKeys(
    violations,
    canonical,
    normalized.version === 3 || normalized.version === 4,
    metricMode,
    normalized.version === 5
  );
  const ids = fingerprintIds(stableKeys);
  const metricMatches = metricMode
    ? metricBaselineMatches(violations, stableKeys, normalized)
    : undefined;
  if (metricMatches) for (const id of metricMatches.used) used.add(id);
  let debt = 0;
  for (const [index, v] of violations.entries()) {
    const id = ids[index]!;
    const legacyKey = key(canonical(v.rule), v.file);
    if (metricMatches?.fresh.has(index)) {
      fresh.push(v);
      continue;
    }
    if (metricMatches?.matched.has(index)) {
      debt++;
      continue;
    }
    if (available.has(id) && !used.has(id)) {
      used.add(id);
      const previousMetrics = normalized.metrics?.[id];
      if (
        metricMode &&
        v.metrics &&
        (!previousMetrics || metricWorsened(v.metrics, previousMetrics))
      )
        fresh.push(v);
      else debt++;
    } else {
      legacySeen[legacyKey] = (legacySeen[legacyKey] ?? 0) + 1;
      if (legacySeen[legacyKey] <= (normalized.legacy[legacyKey] ?? 0)) debt++;
      else fresh.push(v);
    }
  }
  const currentLegacy = countByKey(
    violations.filter((_, index) => !available.has(ids[index]!)),
    canonical
  );
  const legacyFixed = Object.entries(normalized.legacy).reduce(
    (sum, [entry, count]) =>
      sum + Math.max(0, count - (currentLegacy[entry] ?? 0)),
    0
  );
  const fixed =
    normalized.findings.filter((entry) => !used.has(entry)).length +
    legacyFixed;
  return { fresh, debt, fixed };
}
