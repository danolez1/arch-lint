# Biome compatibility

Some projects lint and format with Biome and keep a `biome.json` at the root. When such a project runs `arch-lint lint` or `arch-lint format`, arch-lint reads the Biome file and maps it onto the bundled ESLint and Prettier, either directly or through `createConfig` in the project's own config. Without that, `format` would rewrite the whole project to the bundled defaults (width 80, ES5 commas) and `lint` would never enforce the rules the project chose.

Biome and Prettier are close but not identical, so this is a translation, not a guarantee of byte-identical output. Anything that cannot be carried over is printed once to stderr, so nothing is dropped silently.

## How detection works

- The file is `biome.json` or `biome.jsonc` in the project root (the directory passed with `--cwd`, or the current one). If both exist, `biome.json` wins. Comments and trailing commas are accepted in both. Parent directories are not searched.
- With no `eslint.config.*` or Prettier config in the root or any parent, the CLI runs the bundled configs and they use the mapping. A project config that calls `createConfig` from `@danolez/arch-lint/eslint` or `@danolez/arch-lint/prettier` gets the mapping too, because `createConfig` reads `biome.json` by default. A project config that does not call `createConfig` is unaffected: the bundled config is never loaded for it and `biome.json` is ignored for that tool. The two tools are decided separately.
- A project without a `biome.json` behaves exactly as before.
- A `biome.json` that cannot be parsed stops the command with exit code 2 and the file name in the message.

Options a `biome.json` leaves out take Biome's defaults, not the bundled Prettier defaults, because Biome is the tool that project formats with. The notable differences are tabs for indentation (`indentStyle` defaults to `tab`) and trailing commas on everything (`all`). The bundled defaults only apply when there is no `biome.json`, or when the formatter is switched off in it.

## Formatter

The `formatter` section and `javascript.formatter` are merged, with the JavaScript section winning, which is how Biome resolves them.

| Biome option        | Prettier option                | Biome default | Notes                                                                             |
| ------------------- | ------------------------------ | ------------- | --------------------------------------------------------------------------------- |
| `indentStyle`       | `useTabs`                      | `tab`         | `tab` is true, `space` is false.                                                  |
| `indentWidth`       | `tabWidth`                     | 2             |                                                                                   |
| `lineWidth`         | `printWidth`                   | 80            |                                                                                   |
| `lineEnding`        | `endOfLine`                    | `lf`          | `lf`, `crlf`, `cr` and `auto` carry over.                                         |
| `quoteStyle`        | `singleQuote`                  | `double`      |                                                                                   |
| `jsxQuoteStyle`     | `jsxSingleQuote`               | `double`      |                                                                                   |
| `quoteProperties`   | `quoteProps`                   | `asNeeded`    | `asNeeded` becomes `as-needed`.                                                   |
| `trailingCommas`    | `trailingComma`                | `all`         | `all`, `es5` and `none`. The older `trailingComma` spelling is accepted too.      |
| `semicolons`        | `semi`                         | `always`      | `asNeeded` becomes `semi: false`.                                                 |
| `arrowParentheses`  | `arrowParens`                  | `always`      | `asNeeded` becomes `avoid`.                                                       |
| `bracketSpacing`    | `bracketSpacing`               | true          |                                                                                   |
| `bracketSameLine`   | `bracketSameLine`              | false         |                                                                                   |
| `attributePosition` | `singleAttributePerLine`       | `auto`        | `multiline` becomes true. This is the closest Prettier option, not an exact twin. |
| `expand`            | `objectWrap`                   | `auto`        | `auto` is `preserve`, `never` is `collapse`. `always` has no equivalent.          |
| `operatorLinebreak` | `experimentalOperatorPosition` | `after`       | `after` is `end`, `before` is `start`.                                            |

Options with no Prettier equivalent are reported when the file sets them: `trailingNewline` (Prettier always writes one final newline), `delimiterSpacing`, and `useEditorconfig` (options the file leaves out use Biome's defaults, not `.editorconfig` values). `formatWithErrors` is ignored because Prettier never formats a file it cannot parse.

When `formatter.enabled` or `javascript.formatter.enabled` is false, no formatter option is mapped and the bundled Prettier defaults apply, with a note.

Settings for other languages (`css`, `json`, `graphql`, `html`) are reported and not mapped. Prettier uses its defaults for those files.

### Import sorting

Import sorting stays on unless the file turns it off. That is `organizeImports.enabled: false` in the 1.x layout, or `assist.actions.source.organizeImports: "off"` (or `assist.enabled: false`) in the 2.x layout. When it is on, the bundled `prettier-plugin-organize-imports` does the sorting. It uses the TypeScript compiler's ordering, which can differ from Biome's, and arch-lint says so in its notes. Import groups and path filters are reported and not mapped. Other assist actions, such as sorted keys, have no Prettier counterpart and are reported when enabled.

## Linter

`linter.rules.recommended: true` (2.x also `preset: "recommended"`), or no setting at all, maps to the typescript-eslint recommended set that the bundled config already enables. Biome has no per-rule list of that set, so individual recommended rules are not matched one by one. If the file turns the recommended set off (`recommended: false`, or a `preset` of `none` or `all`), ESLint cannot switch off part of a preset, so a note says the recommended set stays on.

| Biome rule                               | ESLint rule                                | Notes                                                                                                                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `correctness.noUnusedImports`            | `@typescript-eslint/no-unused-vars`        | ESLint has one rule for unused imports and unused variables. If the two Biome rules disagree, or only one is set, the stricter level is used and a note says so. The core `no-unused-vars` is switched off so nothing is reported twice. |
| `correctness.noUnusedVariables`          | `@typescript-eslint/no-unused-vars`        | Names starting with an underscore are ignored, as in Biome. `ignoreRestSiblings` follows the Biome option and defaults to true. Function parameters are not checked (`args: "none"`), because Biome has a separate rule for them.        |
| `correctness.noUnusedFunctionParameters` | `@typescript-eslint/no-unused-vars`        | Not a rule of its own: when it is set above `off` next to `noUnusedImports` or `noUnusedVariables`, the shared rule uses `args: "after-used"` and unused parameters are reported. Set alone it adds nothing, and a note says so.         |
| `style.useConst`                         | `prefer-const`                             |                                                                                                                                                                                                                                          |
| `style.useTemplate`                      | `prefer-template`                          |                                                                                                                                                                                                                                          |
| `style.noNonNullAssertion`               | `@typescript-eslint/no-non-null-assertion` |                                                                                                                                                                                                                                          |
| `suspicious.noExplicitAny`               | `@typescript-eslint/no-explicit-any`       |                                                                                                                                                                                                                                          |
| `suspicious.noConsole`                   | `no-console`                               | The `allow` option carries over.                                                                                                                                                                                                         |
| `suspicious.noDebugger`                  | `no-debugger`                              |                                                                                                                                                                                                                                          |
| `suspicious.noVar`                       | `no-var`                                   | Biome 1.x keeps this rule under `style`.                                                                                                                                                                                                 |
| `suspicious.noDoubleEquals`              | `eqeqeq`                                   | `ignoreNull` (default true) becomes `{ null: "ignore" }`.                                                                                                                                                                                |
| `style.useBlockStatements`               | `curly`                                    | Mapped to `all`.                                                                                                                                                                                                                         |
| `style.noParameterAssign`                | `no-param-reassign`                        |                                                                                                                                                                                                                                          |

Rules are matched by name, so a rule that moved between groups in a newer Biome release still maps.

### Levels

| Biome level | ESLint level                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `error`     | `error`                                                                                                                                  |
| `warn`      | `warn`                                                                                                                                   |
| `info`      | `warn`, because ESLint has no info level                                                                                                 |
| `on`        | `warn`. Biome applies each rule's own default severity, which is a warning (or information for `useTemplate`) for the rules mapped here. |
| `off`       | `off`                                                                                                                                    |

A rule written as an object (`{ "level": "error", "options": { ... } }`) is read the same way.

### Overrides

Each entry in `overrides` becomes an ESLint config block after the base rules, in the same order, so later entries win just as they do in Biome.

- The 2.x `includes` list becomes `files`, with entries starting with `!` becoming `ignores`. The 1.x `include` and `ignore` lists map the same way.
- A name with no glob and no file extension is treated as a folder, as Biome does, so `src/legacy` becomes `src/legacy` and `src/legacy/**`.
- An override with `linter.enabled: false` adds its paths to the ESLint ignores. Excluded paths in such an override are not honoured, and a note says so.
- An override with `formatter.enabled: false` adds its paths to the Prettier ignore patterns.
- An override with no include patterns is skipped and reported, because an ESLint block with no `files` would apply to everything.
- Per-path formatter options are reported and not mapped. Prettier matches its `overrides` globs relative to the config file, which here lives inside the arch-lint package, so project paths cannot be expressed reliably.

## Ignored paths

| Biome setting                                          | ESLint                                     | Prettier                                                         |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------- |
| `files.includes` entries starting with `!` (also `!!`) | `ignores`                                  | ignore patterns                                                  |
| `files.ignore` (1.x)                                   | `ignores`                                  | ignore patterns                                                  |
| `linter.includes` negations, `linter.ignore`           | `ignores`                                  | not used                                                         |
| `formatter.includes` negations, `formatter.ignore`     | not used                                   | ignore patterns                                                  |
| `vcs.useIgnoreFile` with `vcs.enabled`                 | the root `.gitignore`, translated to globs | already honoured, the CLI always passes `.gitignore` to Prettier |

Patterns are relative to the project root, as in Biome 2. A pattern such as `dist` matches only the root `dist` folder, and `**/dist` matches it anywhere.

Positive include patterns that narrow the file set, or that re-include something an earlier pattern excluded, are not translated. Only the excluded patterns are. A note says so.

The Prettier patterns are written to a temporary ignore file for the length of the command, with the way back to the project root added to anchored patterns, because Prettier resolves ignore patterns relative to the ignore file. The file is removed afterwards. Ignored files stay ignored when they are named directly on the command line.

The translation of `.gitignore` is simple: a pattern without a slash matches at any depth, a pattern with a slash is anchored to the root, and a trailing slash marks a folder. Negated lines are reported and skipped. Only the root `.gitignore` is read.

## What has no equivalent

| Biome setting                                                                                                              | Why it is not mapped                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Every rule not in the tables above (for example `a11y`, `security`, `complexity`, `performance` rules and most of `style`) | The bundled ESLint config has no matching rule. Each such rule that is set to something other than `off` is listed in the notes. |
| `nursery.useSortedClasses`                                                                                                 | Prettier sorts Tailwind classes only through `prettier-plugin-tailwindcss`, which is not bundled.                                |
| `linter.domains`, `plugins`, `grit`                                                                                        | ESLint has no counterpart to Biome rule domains or plugins.                                                                      |
| `javascript.globals`, `javascript.jsxRuntime`, `javascript.parser`, `javascript.linter`                                    | Not mapped, and listed by name.                                                                                                  |
| `extends`                                                                                                                  | Extended configs are not followed. Settings that live only in a parent file are missing from the mapping.                        |
| `files.experimentalScannerIgnores`                                                                                         | Not mapped.                                                                                                                      |
| `formatter.expand: "always"`                                                                                               | Prettier cannot force every object and array onto several lines.                                                                 |
| `trailingNewline`, `delimiterSpacing`, `useEditorconfig`                                                                   | See the formatter section.                                                                                                       |
| Per-path formatter options in `overrides`                                                                                  | See the overrides section.                                                                                                       |
| `organizeImports` groups and path filters                                                                                  | The sorting plugin has no such options.                                                                                          |
| Group-level settings such as `"style": "off"` and `recommended: false` inside a group                                      | ESLint cannot switch off part of a preset.                                                                                       |

A Biome rule that is set to `off` and has no ESLint counterpart is not reported, since there is nothing to lose.

The mapping also cannot reproduce the severity Biome gives to rules that are on by default. For example `noExplicitAny` is a warning in Biome 2 but an error in typescript-eslint's recommended set, and a project that does not mention it gets the ESLint level.

## Notes at run time

When the mapping is used, the CLI prints the notes to stderr. `lint` prints the linter and file notes, `format` prints the formatter and file notes, and each note appears once per process, so `check` does not repeat what `lint` already said.

```
arch-lint: reading biome.json, not everything carries over:
  nursery.useSortedClasses: Prettier sorts Tailwind classes only through prettier-plugin-tailwindcss, which is not bundled
```

## Using it from your own config

A project config that calls `createConfig` from `@danolez/arch-lint/eslint` or `@danolez/arch-lint/prettier` gets the Biome mapping by default, the same as the bundled config does. `biome: "auto"` is the default and means use `biome.json` when the project root has one. Pass `biome: false` to leave it out.

```js
// eslint.config.mjs
import { createConfig } from "@danolez/arch-lint/eslint";
export default await createConfig({ ignores: ["generated/**"] });
```

```js
// prettier.config.mjs
import { createConfig } from "@danolez/arch-lint/prettier";
export default createConfig({ biome: false });
```

The CLI recognises such a config by the `@danolez/arch-lint/eslint` or `@danolez/arch-lint/prettier` specifier in the config file (or the `prettier` key in `package.json`), and prints the notes and applies the Prettier ignore patterns for it as it does for the bundled config. A config that contains `biome: false` is treated as opted out. A config that gets `createConfig` from somewhere else, such as a shared package of your own, still gets the ESLint rules, ESLint ignores and Prettier options, but the CLI cannot see the specifier, so the notes are not printed and the Prettier ignore patterns are not applied. List those paths in `.prettierignore`.
