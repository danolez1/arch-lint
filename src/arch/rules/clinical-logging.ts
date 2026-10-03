import { settingsFor } from "../config";
import { matchesAny } from "../paths";
import type { ProjectContext, ProjectRule, Rule, Violation } from "../types";
import { analyzeDartSource } from "./clinical-logging-dart";
import { parseSettings, type FileScope } from "./clinical-logging-settings";
import { analyzeTypeScriptSource } from "./clinical-logging-ts";

// The rules share one analysis pass, so an option set on any of them applies to the whole group.
// A rule's own value wins over another rule's; the option list is in docs/RULE-OPTIONS.md.

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".dart"];

const RULE_SPECS: ReadonlyArray<readonly [string, string]> = [
  [
    "dynamic-module-source-forbidden",
    "Module loads must use fixed string literals so architecture checks keep provenance.",
  ],
  [
    "environment-adapter-required",
    "Runtime environment must be read through the validated env helper, not process, Bun or import.meta env access.",
  ],
  [
    "logger-callback-forbidden",
    "Logger objects, methods and factories must be invoked directly, never aliased, returned, re-exported or passed as callbacks.",
  ],
  [
    "logger-construction-boundary",
    "Loggers may be constructed only in the designated logger adapter files.",
  ],
  [
    "no-direct-clinical-log-argument",
    "Clinical text such as OCR output, document text or patient names must not reach a logger call.",
  ],
  [
    "no-image-body-upload",
    "Image bytes must use the direct object-storage upload protocol, not request bodies in routes or services.",
  ],
  [
    "no-mobile-image-body-upload",
    "Mobile image bytes must use signed object-storage requests, not multipart bodies.",
  ],
  [
    "phi-safe-logger-required",
    "Output must go through the validated logger adapter, not console, process streams, file writes or third-party loggers.",
  ],
  [
    "phi-safe-mobile-logger-required",
    "Mobile production code must not use print, debugPrint or developer log sinks.",
  ],
  [
    "safe-log-event-required",
    "Logger messages must use a registered event identifier.",
  ],
  [
    "safe-log-scalar-source-required",
    "Operational scalar log fields must use the reviewed source expression for that event and field.",
  ],
  ["static-log-message", "Logger messages must be string literals."],
  ["static-logger-service", "Logger service names must be string literals."],
  [
    "tenant-bypass-boundary",
    "Routes must use an authorized service boundary instead of an internal database handle.",
  ],
];

const GROUP_IDS = RULE_SPECS.map(([id]) => id);

// The analysis covers all 14 ids in one pass, so the rules of a run share its results.
const results = new WeakMap<object, Map<string, Violation[]>>();

function sharedOptions(ctx: ProjectContext): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const id of GROUP_IDS)
    Object.assign(merged, ctx.config.rules[id]?.options);
  Object.assign(merged, ctx.options);
  delete merged.message;
  return merged;
}

function layerOption(
  shared: Record<string, unknown>,
  key: string,
  fallback: string
): string {
  const value = shared[key];
  return typeof value === "string" ? value : fallback;
}

function inDefinedLayer(
  ctx: ProjectContext,
  path: string,
  layer: string
): boolean {
  return (
    layer !== "" &&
    ctx.config.layers[layer] !== undefined &&
    ctx.inLayer(path, layer)
  );
}

function makeRule(id: string, description: string): ProjectRule {
  const rule: ProjectRule = {
    kind: "project",
    id,
    description,
    check(ctx) {
      const shared = sharedOptions(ctx);
      const settings = parseSettings(shared);
      const settingsKey = JSON.stringify(shared);
      const layer = settingsFor(ctx.config, rule).layer;
      const message =
        typeof ctx.options.message === "string"
          ? ctx.options.message
          : undefined;
      const tenantLayer = layerOption(shared, "tenantBypassLayer", "routes");
      const routeLayer = layerOption(shared, "imageBodyRouteLayer", "routes");
      const serviceLayer = layerOption(
        shared,
        "imageBodyServiceLayer",
        "services"
      );
      const mobileLayer = layerOption(shared, "mobileUploadLayer", "mobile");
      let cache = results.get(ctx.config);
      if (!cache) {
        cache = new Map();
        results.set(ctx.config, cache);
      }

      const found: Violation[] = [];
      for (const path of ctx.listFiles(SOURCE_EXTENSIONS)) {
        if (matchesAny(path, ctx.config.tests)) continue;
        if (layer && !ctx.inLayer(path, layer)) continue;
        const scope: FileScope = {
          tenantRoute: inDefinedLayer(ctx, path, tenantLayer),
          imageRoute: inDefinedLayer(ctx, path, routeLayer),
          imageService: inDefinedLayer(ctx, path, serviceLayer),
          mobileUpload: inDefinedLayer(ctx, path, mobileLayer),
        };
        const key = `${path}\0${JSON.stringify(scope)}\0${settingsKey}`;
        let violations = cache.get(key);
        if (!violations) {
          const text = ctx.read(path);
          if (text === null) continue;
          violations = path.endsWith(".dart")
            ? analyzeDartSource(path, text, scope)
            : analyzeTypeScriptSource(path, text, settings, scope);
          cache.set(key, violations);
        }
        for (const v of violations) {
          if (v.rule === id)
            found.push(message === undefined ? v : { ...v, message });
        }
      }
      return found;
    },
  };
  return rule;
}

export const RULES: Rule[] = RULE_SPECS.map(([id, description]) =>
  makeRule(id, description)
);
