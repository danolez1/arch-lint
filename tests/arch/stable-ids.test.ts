import assert from "node:assert/strict";
import test from "node:test";
import { REGISTRY, canonicalId } from "../../src/arch/registry";

// Ids and aliases released in 0.1.0. Removing or renaming one breaks configs and baselines in the wild,
// so change this list only together with a deliberate, changelogged decision (a rename keeps the old name as an alias).
const RELEASED_IDS = [
  "dynamic-module-source-forbidden",
  "enum-literal-bypass",
  "environment-adapter-required",
  "err-requires-error-code",
  "kebab-case-filenames",
  "logger-callback-forbidden",
  "logger-construction-boundary",
  "migration-journal-order",
  "migration-no-default-privileges-for-role",
  "migration-no-tx-control",
  "migration-released-immutable",
  "min-touch-target",
  "models-stay-below-services",
  "no-any",
  "no-axios",
  "no-cache-in-models",
  "no-console",
  "no-dash",
  "no-date-methods",
  "no-db-in-routes",
  "no-db-outside-models",
  "no-direct-clinical-log-argument",
  "no-direct-write-audit-in-routes",
  "no-drizzle-push",
  "no-empty-catch",
  "no-feature-import",
  "no-hardcoded-attr-text",
  "no-hardcoded-hex",
  "no-hardcoded-origin",
  "no-image-body-upload",
  "no-inline-styles",
  "no-magic-path",
  "no-mobile-image-body-upload",
  "no-narration-comments",
  "no-raw-fetch",
  "no-raw-fetch-in-components",
  "no-raw-process-env",
  "no-raw-throw",
  "no-relative-cross-package",
  "no-service-in-tsx",
  "no-store-in-features",
  "no-ui-toolkit",
  "no-unsafe-error-cast",
  "no-whole-dir-test-script",
  "phi-redaction-required",
  "phi-safe-logger-required",
  "phi-safe-mobile-logger-required",
  "require-export-jsdoc",
  "require-responsive-layout",
  "safe-log-event-required",
  "safe-log-scalar-source-required",
  "static-log-message",
  "static-logger-service",
  "tenant-bypass-boundary",
  "test-file-naming",
  "tx-delete-then-insert",
  "tx-required-multi-write",
  "tx-service-orchestration",
  "types-in-types-folder",
];

const RELEASED_ALIASES: [string, string][] = [
  ["no-console-log", "no-console"],
  ["no-enum-literal-bypass", "enum-literal-bypass"],
  ["no-hardcoded-jsx-string", "no-hardcoded-attr-text"],
];

test("every released rule id is still registered", () => {
  const registered = new Set(REGISTRY.map((rule) => rule.id));
  const missing = RELEASED_IDS.filter((id) => !registered.has(id));
  assert.deepEqual(missing, []);
});

test("every released alias still resolves to the same rule", () => {
  const changed = RELEASED_ALIASES.filter(
    ([alias, id]) => canonicalId(alias) !== id
  );
  assert.deepEqual(changed, []);
});
