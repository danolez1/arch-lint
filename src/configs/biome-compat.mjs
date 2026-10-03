import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UsageError } from "../util.mjs";

export const BIOME_FILE_NAMES = ["biome.json", "biome.jsonc"];

// A biome.json that leaves an option out gets Biome's default, not the bundled Prettier default, so the output matches what Biome would write.
const BIOME_FORMAT_DEFAULTS = {
  useTabs: true,
  tabWidth: 2,
  printWidth: 80,
  endOfLine: "lf",
  singleQuote: false,
  jsxSingleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  semi: true,
  arrowParens: "always",
  bracketSpacing: true,
  bracketSameLine: false,
  singleAttributePerLine: false,
  objectWrap: "preserve",
  experimentalOperatorPosition: "end",
};

const ENUM_OPTIONS = {
  indentStyle: ["useTabs", { tab: true, space: false }],
  lineEnding: ["endOfLine", { lf: "lf", crlf: "crlf", cr: "cr", auto: "auto" }],
  quoteStyle: ["singleQuote", { single: true, double: false }],
  jsxQuoteStyle: ["jsxSingleQuote", { single: true, double: false }],
  quoteProperties: [
    "quoteProps",
    { asNeeded: "as-needed", preserve: "preserve" },
  ],
  trailingCommas: ["trailingComma", { all: "all", es5: "es5", none: "none" }],
  semicolons: ["semi", { always: true, asNeeded: false }],
  arrowParentheses: ["arrowParens", { always: "always", asNeeded: "avoid" }],
  attributePosition: [
    "singleAttributePerLine",
    { auto: false, multiline: true },
  ],
  expand: ["objectWrap", { auto: "preserve", never: "collapse" }],
  operatorLinebreak: [
    "experimentalOperatorPosition",
    { after: "end", before: "start" },
  ],
};

const NUMBER_OPTIONS = { indentWidth: "tabWidth", lineWidth: "printWidth" };
const BOOLEAN_OPTIONS = {
  bracketSpacing: "bracketSpacing",
  bracketSameLine: "bracketSameLine",
};

const FORMATTER_KEY_NOTES = {
  trailingNewline: "Prettier always ends a file with one newline",
  delimiterSpacing: "Prettier has no option for spacing inside delimiters",
  useEditorconfig:
    "options the file leaves out use Biome's defaults, not .editorconfig values",
};

const UNMAPPED_VALUE_REASONS = {
  expand: "Prettier cannot force every object and array onto several lines",
};

const LEVELS = {
  error: "error",
  warn: "warn",
  info: "warn",
  on: "warn",
  off: "off",
};
const LEVEL_RANK = { off: 0, warn: 1, error: 2 };

const UNUSED_RULES = new Set(["noUnusedImports", "noUnusedVariables"]);
const UNUSED_PARAMS_RULE = "noUnusedFunctionParameters";

// Biome ignores variables that start with an underscore, so the ESLint rule is told to as well.
const UNUSED_VARS_OPTIONS = {
  varsIgnorePattern: "^_",
  argsIgnorePattern: "^_",
  caughtErrorsIgnorePattern: "^_",
  destructuredArrayIgnorePattern: "^_",
};

const SIMPLE_RULES = {
  useConst: ["prefer-const"],
  useTemplate: ["prefer-template"],
  noNonNullAssertion: ["@typescript-eslint/no-non-null-assertion"],
  noExplicitAny: ["@typescript-eslint/no-explicit-any"],
  noConsole: [
    "no-console",
    (options) => (options?.allow?.length ? [{ allow: options.allow }] : []),
  ],
  noVar: ["no-var"],
  noDebugger: ["no-debugger"],
  noDoubleEquals: [
    "eqeqeq",
    (options) => [
      "always",
      ...(options?.ignoreNull === false ? [] : [{ null: "ignore" }]),
    ],
  ],
  useBlockStatements: ["curly", () => ["all"]],
  noParameterAssign: ["no-param-reassign"],
};

const UNMAPPED_RULE_REASONS = {
  useSortedClasses:
    "Prettier sorts Tailwind classes only through prettier-plugin-tailwindcss, which is not bundled",
};

const UNMAPPED_SECTIONS = {
  extends: ["files", "extended configs are not followed"],
  plugins: ["linter", "Biome plugins have no ESLint counterpart"],
  css: ["formatter", "CSS settings are not mapped, Prettier uses its defaults"],
  json: [
    "formatter",
    "JSON settings are not mapped, Prettier uses its defaults",
  ],
  graphql: ["formatter", "GraphQL settings are not mapped"],
  html: ["formatter", "HTML settings are not mapped"],
  grit: ["linter", "Grit settings have no ESLint counterpart"],
};

const MATCH_ALL = new Set(["**", "**/*"]);

const OVERRIDE_KEYS = new Set([
  "include",
  "includes",
  "ignore",
  "linter",
  "formatter",
  "javascript",
  "assist",
  "organizeImports",
]);

const isObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
const unique = (items) => [...new Set(items)];

export function findBiomeConfig(root) {
  for (const name of BIOME_FILE_NAMES) {
    const file = path.join(root, name);
    if (existsSync(file)) return file;
  }
  return null;
}

// Biome accepts comments and trailing commas in both file names, so both are tolerated before JSON.parse.
export function parseJsonc(text) {
  let out = "";
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const skipTrivia = (from) => {
    let j = from;
    for (;;) {
      if (/\s/.test(text[j] ?? "")) j++;
      else if (text.startsWith("//", j)) {
        while (j < text.length && text[j] !== "\n") j++;
      } else if (text.startsWith("/*", j)) {
        const end = text.indexOf("*/", j + 2);
        j = end < 0 ? text.length : end + 2;
      } else return j;
    }
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith("//", i) || text.startsWith("/*", i)) {
      i = skipTrivia(i);
    } else if (ch === ",") {
      const next = text[skipTrivia(i + 1)];
      if (next !== "}" && next !== "]") out += ch;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return JSON.parse(out);
}

const normalize = (pattern) =>
  pattern
    .replace(/^!+/, "")
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");

// A name without a glob or extension is a folder in Biome, so its contents match too.
function toGlobs(pattern) {
  const clean = normalize(pattern);
  const last = clean.split("/").pop();
  const isFolder = !/[*?[]/.test(last) && !/.\./.test(last);
  return isFolder ? [clean, `${clean}/**`] : [clean];
}

function gitignoreGlobs(root, note) {
  const file = path.join(root, ".gitignore");
  if (!existsSync(file)) return [];
  const globs = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      note(
        "linter",
        `.gitignore: negated line "${line}" is not mapped to ESLint ignores`
      );
      continue;
    }
    const clean = line.replace(/\/+$/, "");
    const anchored = clean.includes("/");
    globs.push(anchored ? clean.replace(/^\//, "") : `**/${clean}`);
  }
  return globs;
}

function levelOf(value) {
  const raw = isObject(value) ? value.level : value;
  return Object.hasOwn(LEVELS, raw) ? LEVELS[raw] : undefined;
}

function formatterOptions(sections, note) {
  const merged = Object.assign({}, ...sections.filter(isObject));
  if (
    merged.trailingComma !== undefined &&
    merged.trailingCommas === undefined
  ) {
    merged.trailingCommas = merged.trailingComma;
  }
  const options = {};
  for (const [key, value] of Object.entries(merged)) {
    const label = `formatter.${key}`;
    if (Object.hasOwn(ENUM_OPTIONS, key)) {
      const [target, values] = ENUM_OPTIONS[key];
      if (Object.hasOwn(values, value)) options[target] = values[value];
      else {
        note(
          "formatter",
          `${label}: "${value}" has no Prettier equivalent${UNMAPPED_VALUE_REASONS[key] ? `, ${UNMAPPED_VALUE_REASONS[key]}` : ""}`
        );
      }
    } else if (Object.hasOwn(NUMBER_OPTIONS, key)) {
      if (Number.isFinite(value)) options[NUMBER_OPTIONS[key]] = value;
      else
        note("formatter", `${label}: expected a number, left at the default`);
    } else if (Object.hasOwn(BOOLEAN_OPTIONS, key)) {
      if (typeof value === "boolean") options[BOOLEAN_OPTIONS[key]] = value;
      else
        note(
          "formatter",
          `${label}: expected true or false, left at the default`
        );
    } else if (Object.hasOwn(FORMATTER_KEY_NOTES, key)) {
      note("formatter", `${label}: ${FORMATTER_KEY_NOTES[key]}`);
    }
  }
  return options;
}

function organizeImportsEnabled(config, note) {
  const v2 = config.assist?.actions?.source?.organizeImports;
  let enabled = true;
  if (config.assist?.enabled === false) enabled = false;
  else if (v2 !== undefined) enabled = levelOf(v2) !== "off";
  else if (config.organizeImports !== undefined) {
    enabled = config.organizeImports?.enabled !== false;
  }
  if (!enabled) return false;
  if (
    isObject(v2) &&
    (v2.options ||
      config.organizeImports?.include ||
      config.organizeImports?.ignore)
  ) {
    note(
      "formatter",
      "organizeImports: import groups and path filters are not mapped"
    );
  }
  note(
    "formatter",
    "organizeImports: imports are sorted by prettier-plugin-organize-imports, whose order can differ from Biome's"
  );
  return true;
}

function eslintEntry(level, args) {
  return level === "off" || args.length === 0 ? level : [level, ...args];
}

function mapRules(rules, note) {
  const mapped = {};
  const unused = new Map();
  let unusedParams = "off";
  for (const [group, entries] of Object.entries(isObject(rules) ? rules : {})) {
    if (group === "recommended" || group === "preset") continue;
    if (!isObject(entries)) {
      note(
        "linter",
        `linter.rules.${group}: group-level settings are not mapped`
      );
      continue;
    }
    for (const [name, value] of Object.entries(entries)) {
      if (name === "recommended") {
        if (value === false) {
          note(
            "linter",
            `linter.rules.${group}.recommended is false: ESLint cannot switch off part of a preset`
          );
        }
        continue;
      }
      const level = levelOf(value);
      if (!level) {
        note(
          "linter",
          `${group}.${name}: level is not recognised, rule skipped`
        );
        continue;
      }
      const options = isObject(value) ? value.options : undefined;
      if (UNUSED_RULES.has(name)) unused.set(name, { level, options });
      else if (name === UNUSED_PARAMS_RULE) unusedParams = level;
      else if (Object.hasOwn(SIMPLE_RULES, name)) {
        const [rule, toArgs = () => []] = SIMPLE_RULES[name];
        mapped[rule] = eslintEntry(level, toArgs(options));
      } else if (level !== "off") {
        note(
          "linter",
          `${group}.${name}: ${UNMAPPED_RULE_REASONS[name] ?? "no equivalent in the bundled ESLint rules"}`
        );
      }
    }
  }
  if (unused.size > 0) {
    const levels = [...unused.values()].map((entry) => entry.level);
    const level = levels.reduce((a, b) =>
      LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b
    );
    const restSiblings =
      unused.get("noUnusedVariables")?.options?.ignoreRestSiblings;
    mapped["no-unused-vars"] = "off";
    mapped["@typescript-eslint/no-unused-vars"] = eslintEntry(level, [
      {
        ...UNUSED_VARS_OPTIONS,
        ignoreRestSiblings: restSiblings !== false,
        // Biome reports unused parameters through its own rule, so they stay unchecked unless that one is on.
        args: unusedParams === "off" ? "none" : "after-used",
      },
    ]);
    if (unused.size < 2 || new Set(levels).size > 1) {
      note(
        "linter",
        `noUnusedImports and noUnusedVariables share one ESLint rule, so both use the stricter level (${level})`
      );
    }
  } else if (unusedParams !== "off") {
    note(
      "linter",
      `correctness.${UNUSED_PARAMS_RULE}: only applies together with noUnusedImports or noUnusedVariables, because ESLint reports all three through one rule`
    );
  }
  return mapped;
}

function overrideTargets(override) {
  const patterns = [
    ...strings(override.includes),
    ...strings(override.include),
  ];
  return {
    files: patterns.filter((pattern) => !pattern.startsWith("!")),
    excluded: [
      ...patterns.filter((pattern) => pattern.startsWith("!")),
      ...strings(override.ignore),
    ],
  };
}

function scopeIgnores(section, label, note) {
  const entries = [...strings(section?.includes), ...strings(section?.include)];
  const positive = entries.filter(
    (entry) => !entry.startsWith("!") && !MATCH_ALL.has(entry)
  );
  if (positive.length > 0) {
    note(
      "files",
      `${label}: include patterns that narrow or re-include files are not mapped, only the excluded patterns are`
    );
  }
  return [
    ...entries.filter((entry) => entry.startsWith("!")),
    ...strings(section?.ignore),
  ];
}

function noteUnhandledKeys(config, note) {
  for (const [key, [area, reason]] of Object.entries(UNMAPPED_SECTIONS)) {
    if (config[key] !== undefined) note(area, `${key}: ${reason}`);
  }
  for (const key of Object.keys(config.javascript ?? {})) {
    if (key !== "formatter") note("linter", `javascript.${key}: not mapped`);
  }
  for (const key of Object.keys(config.linter?.domains ?? {})) {
    note(
      "linter",
      `linter.domains.${key}: Biome rule domains have no ESLint counterpart`
    );
  }
  for (const [action, value] of Object.entries(
    config.assist?.actions?.source ?? {}
  )) {
    if (action !== "organizeImports" && levelOf(value) !== "off") {
      note(
        "formatter",
        `assist.actions.source.${action}: no Prettier equivalent`
      );
    }
  }
  if (config.files?.experimentalScannerIgnores !== undefined) {
    note("files", "files.experimentalScannerIgnores: not mapped");
  }
}

export function mapBiomeConfig(config, { root, file = "biome.json" } = {}) {
  if (!isObject(config))
    throw new UsageError(`${file}: expected a JSON object`);
  const notes = [];
  const note = (area, message) => {
    if (!notes.some((entry) => entry.message === message)) {
      notes.push({ area, message });
    }
  };
  noteUnhandledKeys(config, note);

  const filesIgnored = scopeIgnores(config.files, "files", note);
  const eslintIgnored = [
    ...filesIgnored,
    ...scopeIgnores(config.linter, "linter", note),
  ];
  const prettierIgnored = [
    ...filesIgnored,
    ...scopeIgnores(config.formatter, "formatter", note),
  ];
  const eslintIgnores = eslintIgnored.flatMap(toGlobs);
  const prettierIgnore = prettierIgnored.map(normalize);

  if (config.vcs?.enabled !== false && config.vcs?.useIgnoreFile && root) {
    eslintIgnores.push(...gitignoreGlobs(root, note));
  }

  const linterOn = config.linter?.enabled !== false;
  const rules = linterOn ? config.linter?.rules : undefined;
  if (!linterOn)
    note(
      "linter",
      "linter.enabled is false: no ESLint rules are derived from this file"
    );
  if (rules?.recommended === false || ["none", "all"].includes(rules?.preset)) {
    note(
      "linter",
      "linter.rules preset is not the default: the bundled typescript-eslint recommended set stays on as is"
    );
  }

  const eslintRules = linterOn ? mapRules(rules, note) : {};
  const eslintOverrides = [];
  const overrides = Array.isArray(config.overrides) ? config.overrides : [];
  for (const [index, override] of overrides.entries()) {
    if (!isObject(override)) continue;
    const where = `overrides[${index}]`;
    const { files, excluded } = overrideTargets(override);
    if (files.length === 0) {
      note("files", `${where}: no include patterns, override skipped`);
      continue;
    }
    for (const key of Object.keys(override)) {
      if (!OVERRIDE_KEYS.has(key)) note("files", `${where}.${key}: not mapped`);
    }
    const switchedOff = (area) => {
      if (excluded.length > 0) {
        note(
          area,
          `${where}: excluded patterns are ignored when a tool is switched off for the override`
        );
      }
    };

    if (override.linter?.enabled === false) {
      switchedOff("linter");
      eslintIgnores.push(...files.flatMap(toGlobs));
    } else {
      const blockRules = mapRules(override.linter?.rules, note);
      if (Object.keys(blockRules).length > 0) {
        eslintOverrides.push({
          files: files.flatMap(toGlobs),
          ...(excluded.length > 0 && { ignores: excluded.flatMap(toGlobs) }),
          rules: blockRules,
        });
      }
    }

    const formatterSections = [
      override.formatter,
      override.javascript?.formatter,
    ];
    if (formatterSections.some((section) => section?.enabled === false)) {
      switchedOff("formatter");
      prettierIgnore.push(...files.map(normalize));
    } else if (
      Object.keys(formatterOptions(formatterSections, () => {})).length > 0
    ) {
      note(
        "formatter",
        `${where}: per-path formatter options are not mapped, Prettier resolves override globs relative to the config file`
      );
    }
  }

  const formatterOn = ![config.formatter, config.javascript?.formatter].some(
    (section) => section?.enabled === false
  );
  if (!formatterOn) {
    note(
      "formatter",
      "formatter.enabled is false: the bundled Prettier defaults apply"
    );
  }
  const prettier = formatterOn
    ? {
        ...BIOME_FORMAT_DEFAULTS,
        ...formatterOptions(
          [config.formatter, config.javascript?.formatter],
          note
        ),
      }
    : {};

  return {
    file,
    prettier,
    organizeImports: formatterOn ? organizeImportsEnabled(config, note) : true,
    prettierIgnore: unique(prettierIgnore),
    eslint: {
      rules: eslintRules,
      ignores: unique(eslintIgnores),
      overrides: eslintOverrides,
    },
    notes,
  };
}

export function loadBiomeCompat(root) {
  const file = findBiomeConfig(root);
  if (!file) return null;
  let config;
  try {
    config = parseJsonc(readFileSync(file, "utf8"));
  } catch (err) {
    throw new UsageError(`${path.basename(file)}: ${err.message}`);
  }
  return mapBiomeConfig(config, { root, file: path.basename(file) });
}

const reported = new Set();

// Notes print once per process so `check` does not repeat what `lint` and `format` share.
export function reportBiomeNotes(compat, areas) {
  const fresh = compat.notes.filter(
    (entry) => areas.includes(entry.area) && !reported.has(entry.message)
  );
  if (fresh.length === 0) return;
  const lines = fresh.map((entry) => {
    reported.add(entry.message);
    return `  ${entry.message}\n`;
  });
  process.stderr.write(
    `arch-lint: reading ${compat.file}, not everything carries over:\n${lines.join("")}`
  );
}

// Prettier resolves ignore patterns against the ignore file's folder, so root-anchored ones carry the way back to the project root.
// Both paths are resolved through symlinks because Prettier works from the real working directory.
export function withPrettierIgnoreFile(root, patterns, run) {
  if (patterns.length === 0) return run(null);
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "arch-lint-")));
  const back = path.relative(dir, realpathSync(root)).split(path.sep).join("/");
  const file = path.join(dir, "biome.prettierignore");
  writeFileSync(
    file,
    `${patterns.map((p) => (p.startsWith("**/") ? p : `${back}/${p}`)).join("\n")}\n`
  );
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return Promise.resolve(run(file)).finally(cleanup);
}
