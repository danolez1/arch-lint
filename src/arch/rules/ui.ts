import { isCommentLine } from "../source";
import type { FileRule, Rule, SourceFile, Violation } from "../types";
import { messageFor, option, patternRule, violation } from "./util";

const regexCache = new Map<string, RegExp>();

/** Option patterns arrive as strings from JSON config; compiling once per distinct source keeps per-file cost flat. */
function compile(source: string): RegExp {
  let re = regexCache.get(source);
  if (!re) {
    re = new RegExp(source);
    regexCache.set(source, re);
  }
  return re;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

const DEFAULT_TEXT_ATTRIBUTES = ["aria-label", "placeholder", "title", "alt"];

function attrPattern(
  attr: string,
  quotes: string,
  ignoreBraces: boolean
): RegExp {
  const double = quotes === "double";
  const open = double ? `"` : `["']`;
  const excluded = (double ? `"` : `"'`) + (ignoreBraces ? "{}" : "");
  const body = `[^${excluded}]*[A-Za-z]{2,}[^${excluded}]*`;
  const lead = double
    ? `\\b${escapeRegExp(attr)}=`
    : `${escapeRegExp(attr)}=\\s*`;
  return compile(`${lead}${open}${body}${open}`);
}

const noHardcodedAttrText: FileRule = {
  kind: "file",
  id: "no-hardcoded-attr-text",
  aliases: ["no-hardcoded-jsx-string"],
  description:
    "User-facing text in JSX attributes (aria-label, placeholder, title, alt) must come from the translation layer, not a string literal.",
  defaultLayer: "frontend",
  check(file, ctx) {
    if (!file.isTsx) return [];
    const attributes = option<string[]>(
      ctx,
      "attributes",
      DEFAULT_TEXT_ATTRIBUTES
    );
    const quotes = option<string>(ctx, "quotes", "any");
    const ignoreBraces = option<boolean>(ctx, "ignoreBraces", false);
    const onePerLine = option<boolean>(ctx, "onePerLine", false);
    const patterns = attributes.map((attr) => ({
      attr,
      re: attrPattern(attr, quotes, ignoreBraces),
    }));
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      for (const { attr, re } of patterns) {
        if (!re.test(line)) continue;
        found.push(
          violation(
            file.path,
            index + 1,
            "no-hardcoded-attr-text",
            messageFor(
              ctx,
              `Hardcoded ${attr} text, move it to the translation layer`
            )
          )
        );
        if (onePerLine) break;
      }
    });
    return found;
  },
};

const HEX_LITERAL = /["'`]#[0-9a-fA-F]{3,8}["'`]|:\s*["']#[0-9a-fA-F]{3,8}["']/;

// The browser theme-color meta must be a literal color, and it comes with a light and dark pair.
const DEFAULT_HEX_SKIP_LINES = ["\\bthemeColor\\s*:", "prefers-color-scheme"];

const noHardcodedHex: FileRule = {
  kind: "file",
  id: "no-hardcoded-hex",
  description:
    "Hex color literals in TSX files must be replaced by semantic design tokens or utility classes.",
  defaultLayer: "frontend",
  check(file, ctx) {
    if (!file.isTsx) return [];
    const skip = option<string[]>(ctx, "skipLines", DEFAULT_HEX_SKIP_LINES).map(
      compile
    );
    const message = messageFor(
      ctx,
      "Use semantic color classes or tokens (bg-primary, text-muted, ...) instead of hardcoded hex colors"
    );
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (/^\s*import\s/.test(line)) return;
      if (skip.some((re) => re.test(line))) return;
      if (HEX_LITERAL.test(line))
        found.push(
          violation(file.path, index + 1, "no-hardcoded-hex", message)
        );
    });
    return found;
  },
};

const noInlineStyles = patternRule({
  id: "no-inline-styles",
  description:
    "Inline style={{...}} props in TSX files are banned; use utility classes.",
  defaultLayer: "frontend",
  pattern: /style=\{\{/,
  message: "Use utility classes instead of inline style={{...}}",
  appliesTo: (file: SourceFile) => file.isTsx,
});

interface LayoutTrigger {
  pattern: string;
  label: string;
}

const DEFAULT_LAYOUT_TRIGGERS: LayoutTrigger[] = [
  { pattern: "\\bgrid-cols-\\d+\\b", label: "grid-cols-*" },
  { pattern: "\\bflex-row\\b", label: "flex-row" },
  { pattern: "\\bw-(64|72|80|96)\\b", label: "w-{64,72,80,96}" },
  { pattern: "\\bw-\\[\\d{3,}px\\]", label: "w-[Npx]" },
];

const DEFAULT_BREAKPOINTS = ["sm", "md", "lg", "xl", "2xl"];

const requireResponsiveLayout: FileRule = {
  kind: "file",
  id: "require-responsive-layout",
  description:
    "Layout-impacting base utilities (grid columns, flex-row, fixed widths) need a responsive breakpoint variant within a few lines.",
  defaultLayer: "frontend",
  check(file, ctx) {
    if (!file.isTsx) return [];
    const triggers = option<LayoutTrigger[]>(
      ctx,
      "triggers",
      DEFAULT_LAYOUT_TRIGGERS
    ).map((t) => ({
      re: compile(t.pattern),
      label: t.label,
    }));
    const breakpoints = option<string[]>(
      ctx,
      "breakpoints",
      DEFAULT_BREAKPOINTS
    );
    const windowSize = option<number>(ctx, "window", 3);
    const responsive = compile(
      `\\b(${breakpoints.map(escapeRegExp).join("|")}):`
    );
    const prefixList = breakpoints.map((b) => `${b}:`).join("/");
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      if (!/["'`]/.test(line)) return;
      const windowText = file.lines
        .slice(
          Math.max(index - windowSize, 0),
          Math.min(index + windowSize, file.lines.length - 1) + 1
        )
        .join(" ");
      for (const { re, label } of triggers) {
        if (!re.test(line)) continue;
        if (responsive.test(windowText)) continue;
        found.push(
          violation(
            file.path,
            index + 1,
            "require-responsive-layout",
            messageFor(
              ctx,
              `"${label}" used without a responsive prefix (${prefixList}). Add a breakpoint variant or exempt the file in the config.`
            )
          )
        );
        break;
      }
    });
    return found;
  },
};

const REM_PX = 16;
const TAILWIND_UNIT_PX = 4;
const DEFAULT_MIN_SIZE = 48;
const DEFAULT_OVERRIDE_MARKER = "arch-lint: min-touch-target-ok";
const DEFAULT_INPUT_TYPES = [
  "checkbox",
  "radio",
  "button",
  "submit",
  "reset",
  "file",
];

type TargetTag = "button" | "a" | "input";

const SIZE_TOKEN = "(\\d+(?:\\.\\d+)?|\\[(?:\\d+(?:\\.\\d+)?)(?:px|rem)\\])";

function tokenToPx(token: string | undefined): number | null {
  if (!token) return null;
  if (token.startsWith("[")) {
    const inner = token.slice(1, -1);
    if (inner.endsWith("px")) return Number(inner.slice(0, -2));
    if (inner.endsWith("rem")) return Number(inner.slice(0, -3)) * REM_PX;
    return null;
  }
  const n = Number(token);
  return Number.isFinite(n) ? n * TAILWIND_UNIT_PX : null;
}

function maxTokenPx(prefix: string, classes: string): number {
  const pattern = new RegExp(
    `(?:^|[\\s"'\`])${prefix}-${SIZE_TOKEN}(?=$|[\\s"'\`])`,
    "g"
  );
  let best = 0;
  for (const match of classes.matchAll(pattern)) {
    const px = tokenToPx(match[1]);
    if (px !== null && px > best) best = px;
  }
  return best;
}

interface HitArea {
  height: number;
  width: number;
  hasAnySizing: boolean;
}

function computeHitArea(classes: string): HitArea {
  const size = maxTokenPx("size", classes);
  const all = maxTokenPx("p", classes);
  // Padding counts on both sides of the box.
  const padH = Math.max(all * 2, maxTokenPx("py", classes) * 2);
  const padW = Math.max(all * 2, maxTokenPx("px", classes) * 2);
  const height = Math.max(
    maxTokenPx("h", classes),
    maxTokenPx("min-h", classes),
    size,
    padH
  );
  const width = Math.max(
    maxTokenPx("w", classes),
    maxTokenPx("min-w", classes),
    size,
    padW
  );
  return { height, width, hasAnySizing: height > 0 || width > 0 };
}

function extractClassNames(windowText: string): string {
  const attr =
    /className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|\{([\s\S]*?)\})/g;
  return [...windowText.matchAll(attr)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4] ?? "")
    .join(" ");
}

// A line end counts as a terminator because multi-line JSX often breaks right after the tag name.
function findInteractiveTag(line: string): TargetTag | null {
  if (/<button(\s|>|\/|$)/.test(line)) return "button";
  if (/<a(\s|>|$)/.test(line)) return "a";
  if (/<input(\s|>|\/|$)/.test(line)) return "input";
  return null;
}

function isDecorativeOrSkippable(
  windowText: string,
  tag: TargetTag,
  inputTypes: string[]
): boolean {
  if (/aria-hidden\s*=\s*["']true["']/.test(windowText)) return true;
  if (/className\s*=\s*["'][^"']*\bsr-only\b/.test(windowText)) return true;
  if (tag === "input") {
    // Text-like inputs fill their container, only box-shaped inputs are touch targets.
    const type = windowText.match(/type\s*=\s*["']([^"']+)["']/)?.[1];
    return type !== undefined && !inputTypes.includes(type);
  }
  // An anchor without href is a semantic wrapper, not interactive on its own.
  return (
    tag === "a" && !/href\s*=/.test(windowText) && !/asChild/.test(windowText)
  );
}

// Capped so a malformed tag cannot trigger a runaway scan.
function findOpeningTagEnd(lines: string[], startLine: number): number {
  const cap = Math.min(startLine + 12, lines.length - 1);
  let depth = 0;
  for (let i = startLine; i <= cap; i++) {
    for (const ch of lines[i] ?? "") {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
      else if (ch === ">" && depth === 0) return i;
    }
  }
  return cap;
}

const minTouchTarget: FileRule = {
  kind: "file",
  id: "min-touch-target",
  description:
    "Interactive elements (button, a with href, box-shaped input) need an effective Tailwind hit area of at least 48 by 48 px.",
  defaultLayer: "frontend",
  check(file, ctx) {
    if (!file.isTsx) return [];
    const min = option<number>(ctx, "minSize", DEFAULT_MIN_SIZE);
    const marker = option<string>(ctx, "marker", DEFAULT_OVERRIDE_MARKER);
    const inputTypes = option<string[]>(ctx, "inputTypes", DEFAULT_INPUT_TYPES);
    const units = min / TAILWIND_UNIT_PX;
    const found: Violation[] = [];
    const { lines } = file;

    lines.forEach((line, index) => {
      if (isCommentLine(line)) return;
      const tag = findInteractiveTag(line);
      if (!tag) return;
      if (line.includes(marker) || (lines[index - 1] ?? "").includes(marker))
        return;

      const windowText = lines
        .slice(index, findOpeningTagEnd(lines, index) + 1)
        .join(" ");
      if (isDecorativeOrSkippable(windowText, tag, inputTypes)) return;

      const { height, width, hasAnySizing } = computeHitArea(
        extractClassNames(windowText)
      );
      if (!hasAnySizing) {
        found.push(
          violation(
            file.path,
            index + 1,
            "min-touch-target",
            messageFor(
              ctx,
              `<${tag}> has no Tailwind size classes. Touch targets must be at least ${min}x${min}px: add h-${units} w-${units} (or larger via min-h-${units} or padding), or annotate with "// ${marker}" if the parent supplies the hit area.`
            )
          )
        );
      } else if (height < min || width < min) {
        found.push(
          violation(
            file.path,
            index + 1,
            "min-touch-target",
            messageFor(
              ctx,
              `<${tag}> effective hit area ${height}x${width}px is below the ${min}x${min}px minimum. Use h-${units} w-${units} or equivalent (min-h-${units}, padding).`
            )
          )
        );
      }
    });
    return found;
  },
};

export const RULES: Rule[] = [
  noHardcodedAttrText,
  noHardcodedHex,
  noInlineStyles,
  requireResponsiveLayout,
  minTouchTarget,
];
