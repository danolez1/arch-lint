import { RULES as clinicalLogging } from "./rules/clinical-logging";
import { RULES as dataLayer } from "./rules/data-layer";
import { RULES as errorsAndTypes } from "./rules/errors-and-types";
import { RULES as flutter } from "./rules/flutter";
import { RULES as hygiene } from "./rules/hygiene";
import { RULES as migrations } from "./rules/migrations";
import { RULES as platform } from "./rules/platform";
import { RULES as ui } from "./rules/ui";
import type { Rule } from "./types";

export const REGISTRY: Rule[] = [
  ...errorsAndTypes,
  ...platform,
  ...ui,
  ...dataLayer,
  ...migrations,
  ...hygiene,
  ...clinicalLogging,
  ...flutter,
];

const byAlias = new Map<string, string>();
for (const rule of REGISTRY)
  for (const alias of rule.aliases ?? []) byAlias.set(alias, rule.id);

export function canonicalId(id: string): string {
  return byAlias.get(id) ?? id;
}

export function findRule(id: string): Rule | undefined {
  return REGISTRY.find((r) => r.id === id || r.aliases?.includes(id));
}

const seen = new Set<string>();
for (const rule of REGISTRY) {
  for (const id of [rule.id, ...(rule.aliases ?? [])]) {
    if (seen.has(id)) throw new Error(`Rule id "${id}" is registered twice`);
    seen.add(id);
  }
}
