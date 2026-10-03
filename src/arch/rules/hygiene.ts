import { basename, extname } from "node:path";
import { matchesAny } from "../paths";
import type { FileRule, ProjectRule, Rule, Violation } from "../types";
import { messageFor, option, violation } from "./util";

const DEFAULT_BANNED_PREFIXES = [
  "constructor",
  "imports",
  "return the",
  "create a",
  "define",
  "set the",
  "get the",
  "end of",
  "start the",
  "initialize",
  "initialise",
];

// The keys are config values for the `skip` option, so renaming one breaks existing configs.
const SKIP_KINDS: Record<string, (trimmed: string) => boolean> = {
  "triple-slash": (t) => t.startsWith("///"),
  "todo-tags": (t) => /\/\/\s*(TODO|FIXME|HACK|NOTE):/i.test(t),
  "todo-tags-bare": (t) => /\/\/\s*(TODO|FIXME|HACK|NOTE)\b/.test(t),
  "tool-directives": (t) => /\/\/\s*(biome-ignore|eslint-disable|@ts-)/.test(t),
  "tool-directives-extended": (t) =>
    /\/\/\s*(eslint-|prettier-|@ts-|istanbul|biome-)/.test(t),
  dividers: (t) => /\/\/\s*─/.test(t),
  "dividers-dashes": (t) => /\/\/\s*[─-]/.test(t),
  "category-markers": (t) => /\/\/\s*\w+\.\*/.test(t),
  "dash-headers": (t) => /\/\/\s*--\s*.+\s*--/.test(t),
};

const DEFAULT_SKIP = [
  "triple-slash",
  "todo-tags",
  "tool-directives",
  "dividers-dashes",
  "category-markers",
];

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

const noNarrationComments: FileRule = {
  kind: "file",
  id: "no-narration-comments",
  description:
    "A comment must explain why, not restate the code. Flags short comments that start with a banned prefix and comments that mostly repeat the next code line.",
  check(file, ctx) {
    const prefixes = option(ctx, "bannedPrefixes", DEFAULT_BANNED_PREFIXES).map(
      (p) => p.toLowerCase()
    );
    const maxPrefixWords = option(ctx, "maxPrefixWords", 5);
    const threshold = option(ctx, "overlapThreshold", 0.6);
    const minOverlapWords = option(ctx, "minOverlapWords", 0);
    const skips = option(ctx, "skip", DEFAULT_SKIP)
      .filter((kind) => Object.hasOwn(SKIP_KINDS, kind))
      .map((kind) => SKIP_KINDS[kind] as (trimmed: string) => boolean);

    const found: Violation[] = [];
    file.lines.forEach((line, i) => {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("//")) return;
      if (skips.some((skip) => skip(trimmed))) return;

      const text = trimmed.replace(/^\/\/\s*/, "");
      const wordCount = text.split(/\s+/).length;
      const lower = text.toLowerCase().trim();
      if (
        wordCount <= maxPrefixWords &&
        prefixes.some((p) => lower.startsWith(p))
      ) {
        found.push(
          violation(
            file.path,
            i + 1,
            "no-narration-comments",
            messageFor(
              ctx,
              `Comment narrates the code, explain why instead of what: "${text}"`
            )
          )
        );
        return;
      }

      if (wordCount <= minOverlapWords) return;

      const next = file.lines
        .slice(i + 1, i + 4)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith("//"));
      // A comment above a closing brace usually justifies an empty block.
      if (!next || next === "}") return;

      const codeTokens = new Set(tokenise(next));
      const commentTokens = tokenise(text);
      if (commentTokens.length === 0 || codeTokens.size === 0) return;
      const overlap =
        commentTokens.filter((t) => codeTokens.has(t)).length /
        commentTokens.length;
      if (overlap >= threshold) {
        found.push(
          violation(
            file.path,
            i + 1,
            "no-narration-comments",
            messageFor(
              ctx,
              `Comment restates the next line (${Math.round(overlap * 100)}% token overlap), explain why instead of what: "${text}"`
            )
          )
        );
      }
    });
    return found;
  },
};

const kebabCaseFilenames: ProjectRule = {
  kind: "project",
  id: "kebab-case-filenames",
  description:
    "File names must be kebab-case, with no uppercase letters in the base name.",
  check(ctx) {
    const layer = option<string | undefined>(ctx, "layer", undefined);
    const extensions = option(ctx, "extensions", [".ts", ".tsx"]);
    const skipTests = option(ctx, "skipTests", false);
    const skipDeclarations = option(ctx, "skipDeclarations", false);

    const found: Violation[] = [];
    for (const path of ctx.listFiles(extensions)) {
      if (layer !== undefined && !ctx.inLayer(path, layer)) continue;
      if (skipDeclarations && path.endsWith(".d.ts")) continue;
      if (skipTests && matchesAny(path, ctx.config.tests)) continue;
      const ext = extname(path);
      const base = basename(path, ext);
      if (!/[A-Z]/.test(base)) continue;
      found.push(
        violation(
          path,
          0,
          "kebab-case-filenames",
          messageFor(ctx, `File name "${base}${ext}" must use kebab-case`)
        )
      );
    }
    return found;
  },
};

const DEFAULT_TEST_SUFFIXES = [
  ".unit.test.ts",
  ".fn.test.ts",
  ".integration.test.ts",
  ".load.test.ts",
  ".contract.test.ts",
  ".e2e.test.ts",
  ".performance.test.ts",
];

const testFileNaming: ProjectRule = {
  kind: "project",
  id: "test-file-naming",
  description:
    "Test files must end with one of the accepted category suffixes, such as .unit.test.ts.",
  defaultLevel: "off",
  check(ctx) {
    const suffixes = option(ctx, "suffixes", DEFAULT_TEST_SUFFIXES);
    const testFileSuffixes = option(ctx, "testFileSuffixes", [".test.ts"]);
    const patterns = option(ctx, "patterns", ctx.config.tests);
    const skipPathParts = option(ctx, "skipPathParts", ["/setup/"]);
    const message = messageFor(
      ctx,
      `Test file names must end with one of: ${suffixes.join(", ")}`
    );

    const found: Violation[] = [];
    for (const path of ctx.listFiles()) {
      if (!testFileSuffixes.some((s) => path.endsWith(s))) continue;
      if (!matchesAny(path, patterns)) continue;
      if (skipPathParts.some((part) => path.includes(part))) continue;
      if (suffixes.some((s) => path.endsWith(s))) continue;
      found.push(violation(path, 0, "test-file-naming", message));
    }
    return found;
  },
};

export interface WholeDirOptions {
  /** "strict" reads every command separator, skips flag values and flags bare or multi-file calls. "basic" reads `&&` only and flags the first non-file argument. */
  variant: "strict" | "basic";
  command: string;
  valueFlags: string[];
  testFileSuffixes: string[];
}

export const WHOLE_DIR_DEFAULTS: WholeDirOptions = {
  variant: "strict",
  command: "bun test",
  valueFlags: ["--timeout", "--env-file", "--preload", "--rerun-each", "-t"],
  testFileSuffixes: [".test.ts", ".test.tsx"],
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Describes the first call in a test script that would run more than one test file in a process, else null. */
export function findWholeDirTarget(
  script: string,
  opts: Partial<WholeDirOptions> = {}
): string | null {
  const { variant, command, valueFlags, testFileSuffixes } = {
    ...WHOLE_DIR_DEFAULTS,
    ...opts,
  };
  const words = command.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  const isTestFile = (arg: string) =>
    testFileSuffixes.some((s) => arg.endsWith(s));

  if (variant === "basic") {
    for (const seg of script.split("&&")) {
      const m = seg.match(new RegExp(`\\b${words}\\s+(.+)`));
      if (!m) continue;
      const args = (m[1] ?? "").trim().split(/\s+/);
      const dir = args.find((a) => !a.startsWith("-") && !isTestFile(a));
      if (dir) return `"${dir}"`;
    }
    return null;
  }

  for (const seg of script.split(/&&|;|\|\|/)) {
    const m = seg.match(new RegExp(`\\b${words}\\b(.*)`));
    if (!m) continue;
    const args = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
    const positionals: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (!arg.startsWith("-")) positionals.push(arg);
      else if (valueFlags.includes(arg)) i++;
    }
    if (positionals.length === 0) return "every test file in the package";
    const dir = positionals.find((a) => !isTestFile(a));
    if (dir) return `"${dir}"`;
    if (positionals.length > 1) return `${positionals.length} files together`;
  }
  return null;
}

function readScript(text: string | null, script: string): string | undefined {
  if (text === null) return undefined;
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> })
      .scripts;
    const value = scripts?.[script];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

const noWholeDirTestScript: ProjectRule = {
  kind: "project",
  id: "no-whole-dir-test-script",
  description:
    "A package test script must run test files one by one when the suite uses a module mock that bleeds across files in one process.",
  defaultLevel: "off",
  check(ctx) {
    const variant = option(ctx, "variant", WHOLE_DIR_DEFAULTS.variant);
    const manifests = option(ctx, "manifests", ["**/package.json"]);
    const script = option<string>(ctx, "script", "test");
    const command = option(ctx, "command", WHOLE_DIR_DEFAULTS.command);
    const valueFlags = option(ctx, "valueFlags", WHOLE_DIR_DEFAULTS.valueFlags);
    const testFileSuffixes = option(
      ctx,
      "testFileSuffixes",
      WHOLE_DIR_DEFAULTS.testFileSuffixes
    );
    const marker = option<string>(ctx, "marker", "mock.module");

    const all = ctx.listFiles();
    const testFiles = all.filter((p) =>
      testFileSuffixes.some((s) => p.endsWith(s))
    );

    const found: Violation[] = [];
    for (const manifest of all.filter((p) => matchesAny(p, manifests))) {
      const testScript = readScript(ctx.read(manifest), script);
      if (!testScript) continue;

      const dir = manifest.replace(/(^|\/)package\.json$/, "");
      const prefix = dir === "" ? "" : `${dir}/`;
      const usesMarker =
        marker === "" ||
        testFiles.some(
          (f) => f.startsWith(prefix) && (ctx.read(f) ?? "").includes(marker)
        );
      if (!usesMarker) continue;

      const offender = findWholeDirTarget(testScript, {
        variant,
        command,
        valueFlags,
        testFileSuffixes,
      });
      if (!offender) continue;
      found.push(
        violation(
          manifest,
          0,
          "no-whole-dir-test-script",
          messageFor(
            ctx,
            `The "${script}" script runs ${offender} in one process, but the suite uses ${marker || "shared state"}, which bleeds across files. Invoke each test file separately.`
          )
        )
      );
    }
    return found;
  },
};

export const RULES: Rule[] = [
  noNarrationComments,
  kebabCaseFilenames,
  testFileNaming,
  noWholeDirTestScript,
];
