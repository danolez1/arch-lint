import type { ProjectContext, ProjectRule, Rule, Violation } from "../types";
import { messageFor, option, violation } from "./util";

interface DartSource {
  /** Project-relative path, used in violations so include and exemptions match it. */
  path: string;
  /** Path below the Dart root, used for directory logic. */
  rel: string;
  lines: string[];
}

interface DartImport {
  line: number;
  target: string;
}

const DEFAULT_NON_UI_DIRS = [
  "lib/data/",
  "lib/domain/",
  "lib/sync/",
  "lib/repositories/",
  "lib/auth/",
  "lib/core/",
  "lib/api/",
];
const DEFAULT_UI_TOOLKITS = [
  "package:flutter/material.dart",
  "package:flutter/cupertino.dart",
];
const DEFAULT_STORE_LINK = "https://(play\\.google\\.com|apps\\.apple\\.com)/";
const DEFAULT_STORE_IMPORT = "(^|/)objectbox\\.g\\.dart$";
const DEFAULT_STORE_CALL = "\\.box<\\w+>\\(\\)";

const IMPORT = /^\s*import\s+['"]([^'"]+)['"]/;
const ORIGIN = /https?:\/\/[A-Za-z0-9.-]+(:\d+)?/;

// Dart has no leading-star block comment convention, so only line comments are skipped.
const isComment = (line: string): boolean => line.trimStart().startsWith("//");

function withSlash(dir: string): string {
  return dir === "" || dir.endsWith("/") ? dir : `${dir}/`;
}

function dartSources(ctx: ProjectContext): DartSource[] {
  const root = withSlash(option<string>(ctx, "root", ""));
  const sourceDirs = option<string[]>(ctx, "sourceDirs", ["lib/"]);
  const skipSuffixes = option<string[]>(ctx, "skipSuffixes", [".g.dart"]);
  const found: DartSource[] = [];
  for (const path of ctx.listFiles([".dart"])) {
    if (!path.startsWith(root)) continue;
    const rel = path.slice(root.length);
    if (!sourceDirs.some((dir) => rel.startsWith(dir))) continue;
    if (skipSuffixes.some((suffix) => rel.endsWith(suffix))) continue;
    const text = ctx.read(path);
    if (text === null) continue;
    found.push({ path, rel, lines: text.split("\n") });
  }
  return found;
}

function packageNameOf(ctx: ProjectContext): string {
  const configured = option<string>(ctx, "packageName", "");
  if (configured) return configured;
  const root = withSlash(option<string>(ctx, "root", ""));
  return (
    /^name:\s*(\S+)/m.exec(ctx.read(`${root}pubspec.yaml`) ?? "")?.[1] ?? ""
  );
}

/** Resolves a Dart import to a path below the Dart root, or null for sdk and third-party packages. */
function resolveImport(
  rel: string,
  target: string,
  packageName: string
): string | null {
  const own = packageName ? `package:${packageName}/` : null;
  if (own && target.startsWith(own)) return `lib/${target.slice(own.length)}`;
  if (target.startsWith("package:") || target.startsWith("dart:")) return null;
  const base = rel.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "..") base.pop();
    else if (part !== ".") base.push(part);
  }
  return base.join("/");
}

function importsIn(source: DartSource): DartImport[] {
  const found: DartImport[] = [];
  source.lines.forEach((text, index) => {
    const target = IMPORT.exec(text)?.[1];
    if (target) found.push({ line: index + 1, target });
  });
  return found;
}

const inAny = (rel: string, dirs: string[]): boolean =>
  dirs.some((dir) => rel.startsWith(dir));

const noDash: ProjectRule = {
  kind: "project",
  id: "no-dash",
  description:
    "Dart sources contain no en or em dashes, in code or comments. Options: root, sourceDirs, skipSuffixes.",
  check(ctx) {
    const message = messageFor(
      ctx,
      "en or em dash; use a comma, period or parentheses"
    );
    const found: Violation[] = [];
    for (const source of dartSources(ctx)) {
      source.lines.forEach((text, index) => {
        if (/[\u2013\u2014]/.test(text))
          found.push(violation(source.path, index + 1, "no-dash", message));
      });
    }
    return found;
  },
};

const noUiToolkit: ProjectRule = {
  kind: "project",
  id: "no-ui-toolkit",
  description:
    "Layers that must stay testable without a widget tree do not import a UI toolkit. Options: nonUiDirs, uiToolkits, root, sourceDirs, skipSuffixes.",
  check(ctx) {
    const nonUiDirs = option<string[]>(ctx, "nonUiDirs", DEFAULT_NON_UI_DIRS);
    const toolkits = option<string[]>(ctx, "uiToolkits", DEFAULT_UI_TOOLKITS);
    const found: Violation[] = [];
    for (const source of dartSources(ctx)) {
      if (!inAny(source.rel, nonUiDirs)) continue;
      for (const { line, target } of importsIn(source)) {
        if (!toolkits.includes(target)) continue;
        const message = messageFor(
          ctx,
          `${target} imported outside the UI layer`
        );
        found.push(violation(source.path, line, "no-ui-toolkit", message));
      }
    }
    return found;
  },
};

const noFeatureImport: ProjectRule = {
  kind: "project",
  id: "no-feature-import",
  description:
    "Non-UI layers do not import from the feature (screen) directory, by package path or relative path. Options: nonUiDirs, featureDir, packageName, root, sourceDirs, skipSuffixes.",
  check(ctx) {
    const nonUiDirs = option<string[]>(ctx, "nonUiDirs", DEFAULT_NON_UI_DIRS);
    const featureDir = option<string>(ctx, "featureDir", "lib/features/");
    if (featureDir === "") return [];
    const packageName = packageNameOf(ctx);
    const found: Violation[] = [];
    for (const source of dartSources(ctx)) {
      if (!inAny(source.rel, nonUiDirs)) continue;
      for (const { line, target } of importsIn(source)) {
        if (
          !resolveImport(source.rel, target, packageName)?.startsWith(
            featureDir
          )
        )
          continue;
        const message = messageFor(
          ctx,
          `non-UI layer imports ${target}; move shared logic to a layer both can use`
        );
        found.push(violation(source.path, line, "no-feature-import", message));
      }
    }
    return found;
  },
};

const noStoreInFeatures: ProjectRule = {
  kind: "project",
  id: "no-store-in-features",
  description:
    "Feature (screen) code reaches the local store through a repository, not by importing the store or calling it directly. Options: featureDir, storeImportPattern, storeCallPattern, root, sourceDirs, skipSuffixes.",
  check(ctx) {
    const featureDir = option<string>(ctx, "featureDir", "lib/features/");
    if (featureDir === "") return [];
    const importPattern = new RegExp(
      option<string>(ctx, "storeImportPattern", DEFAULT_STORE_IMPORT)
    );
    const callPattern = new RegExp(
      option<string>(ctx, "storeCallPattern", DEFAULT_STORE_CALL)
    );
    const message = messageFor(
      ctx,
      "screens reach the local store through a repository"
    );
    const found: Violation[] = [];
    for (const source of dartSources(ctx)) {
      if (!source.rel.startsWith(featureDir)) continue;
      for (const { line, target } of importsIn(source)) {
        if (importPattern.test(target))
          found.push(
            violation(source.path, line, "no-store-in-features", message)
          );
      }
      source.lines.forEach((text, index) => {
        if (!isComment(text) && callPattern.test(text)) {
          found.push(
            violation(source.path, index + 1, "no-store-in-features", message)
          );
        }
      });
    }
    return found;
  },
};

const noHardcodedOrigin: ProjectRule = {
  kind: "project",
  id: "no-hardcoded-origin",
  description:
    "Server origins live in one environment helper, so a release build can prove which server it talks to. Exempt that helper through exempt.files. Options: allowedUrlPattern, root, sourceDirs, skipSuffixes.",
  check(ctx) {
    const allowed = new RegExp(
      option<string>(ctx, "allowedUrlPattern", DEFAULT_STORE_LINK)
    );
    const found: Violation[] = [];
    for (const source of dartSources(ctx)) {
      source.lines.forEach((text, index) => {
        if (isComment(text)) return;
        const origin = ORIGIN.exec(text)?.[0];
        if (!origin || allowed.test(text)) return;
        const message = messageFor(
          ctx,
          `${origin} belongs in the environment config helper`
        );
        found.push(
          violation(source.path, index + 1, "no-hardcoded-origin", message)
        );
      });
    }
    return found;
  },
};

export const RULES: Rule[] = [
  noDash,
  noUiToolkit,
  noFeatureImport,
  noStoreInFeatures,
  noHardcodedOrigin,
];
