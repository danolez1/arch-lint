# Rule options

Options go under a rule's `options` key in `arch-lint.config.json`:

```json
{
  "rules": {
    "no-any": { "options": { "variant": "basic" } }
  }
}
```

Every rule also accepts `message`, a string that replaces every message the rule reports. It is left out of the sections below. Patterns given as strings (`modules`, `pattern`, `skipLines` and similar) are regular expression sources. Path patterns follow the rules in [CONFIG.md](CONFIG.md). Defaults below were read from the code that consumes each option.

Rules that only take `message`: `no-raw-throw`, `no-unsafe-error-cast`, `no-raw-fetch-in-components`, `no-inline-styles`, `migration-no-default-privileges-for-role`. Their sections say so.

## Errors and types

### no-raw-throw

- `looseMatch` (default `false`): drop the word boundary before `throw`, so a glued identifier such as `rethrow new Error(` also matches. Older engines matched that way.

### no-unsafe-error-cast

No options.

### err-requires-error-code

- `callee` (default `"err"`): the function whose `return err(...)` calls are checked.
- `codeName` (default `"ErrorCode"`): the text that must appear in the call.
- `lookahead` (default `4`): how many lines below the opening line are searched for `codeName`, because formatters wrap long calls.

### no-empty-catch

- `callbacks` (default `true`): also flag an empty `.catch(() => {})` callback, not just empty `catch` blocks.

### no-any

- `variant` (default `"strict"`): `"strict"` also flags `any[]` and `any` inside generic argument lists, and skips both import and export-from lines. `"basic"` flags only `as any`, `: any` and `<any>`, and skips import lines. Any other value behaves as `"strict"`.

### types-in-types-folder

- `typesDirs` (default `["types/**", "**/types/**"]`): path patterns where exported interfaces and type aliases are allowed.

### enum-literal-bypass

The watch list comes from `values`, from `enumDir`, or both. A value in `values` wins over the same value found in enum files.

- `values`: an array of strings, or an object mapping each value to its enum name. The enum name fills `{enum}` in messages and falls back to `matching` when there is none.
- `enumDir`: a directory or a list of directories whose `.ts` files are read to build the watch list.
- `enumDirRecursive` (default `false`): read subdirectories of `enumDir` too. Without it only files directly inside count.
- `enumValuePattern` (default `=\s*["']([a-z][a-z0-9_]{2,})["']`): regular expression source applied to enum files. The first capture group is the value.
- `ignoreValues` (default: style words such as `default`, `primary`, `small`, `left`, `light`, `none`, `auto` and the `typeof` result names): values skipped when they come from `enumDir`. Giving a list replaces the default.
- `contexts` (default `["comparison", "loose", "reversed", "case", "schema"]`): where a raw value counts as a bypass. `comparison` is `=== "x"` and `!== "x"`, `loose` is `== "x"` and `!= "x"`, `reversed` is `"x" ===`, `case` is `case "x"`, `schema` is a call listed in `schemaCalls` with the value as its first argument, and `union` is a string-literal union member. `union` is off unless listed.
- `schemaCalls` (default `["t.Literal"]`): call names the `schema` context looks for.
- `unionValues`: the subset of values scanned in unions, as an array or an object like `values`. When omitted, every watched value is scanned. Values that appear only here are checked in unions but not in comparisons.
- `report` (default `"each"`): `"first"` keeps only the earliest hit on a line when several values match.
- `unionMessage`: message for union hits, falling back to `message`. Both accept the placeholders `{value}` and `{enum}`.

### require-export-jsdoc

- `skipLayers` (default `[]`): layer names whose files are not checked. A layer the config does not define skips nothing.
- `skipBarrelFiles` (default `false`): skip files whose path ends in `/index.ts`.
- `skipTsx` (default `false`): skip `.tsx` files.
- `genericTypes` (default `true`): also require a JSDoc block on generic type aliases such as `export type X<T> =`. With `false` only plain `export type X =` aliases are checked.

## Platform

### no-raw-process-env

- `memberAccessOnly` (default `false`): flag only `process.env.X` and `process.env[...]`. By default a bare `process.env` (spread or alias) is flagged too, since it leaks the whole environment.
- `exemptLayers` (default `[]`): layers whose files are skipped. An undefined layer exempts nothing.
- `looseMatch` (default `false`): drop the word boundary before `process`, so `myprocess.env` also matches.

### no-console

- `methods` (default `["log", "warn", "error", "info", "debug"]`): console methods that are flagged. Entries that are not plain word characters are ignored.
- `layerMethods` (default `{}`): an object mapping a layer name to its own method list. The first defined layer containing the file wins and replaces `methods` for that file.
- `looseMatch` (default `false`): drop the word boundary before `console`, so `myconsole.log(` also matches.

### phi-redaction-required

- `methods` (default `["log", "warn", "error", "info", "debug", "trace"]`): console methods that are flagged. Limited to the `clinical` layer when the config defines one.

### no-raw-fetch

- `scope` (default `"all"`): `"tsx"` checks only `.tsx` files, `"non-tsx"` only the other files. Any other value behaves as `"non-tsx"`.

### no-raw-fetch-in-components

No options.

### no-axios

- `allowTypeImports` (default `false`): allow `import type` of axios. Value imports, dynamic imports and `require` stay flagged.
- `forms` (default `["import", "export-from", "dynamic", "require"]`): which ways of pulling in axios are reported. A shorter list restricts the rule, for example `["import", "export-from", "require"]` skips dynamic `import("axios")`.
- `multiLineAt` (default `"import"`): for an import that spans lines, report the line of the `import` keyword, or `"from"` for the line of `from "axios"`.

### no-magic-path

- `clients` (default `["apiClient"]`): client names whose `get`, `post`, `put`, `patch` and `delete` calls are checked for a literal path starting with `/`. An empty list turns that part off. Literals in `href`, `router.push`, `router.replace`, `router.prefetch`, `redirect` and `permanentRedirect` are always checked.

### no-relative-cross-package

- `workspaceRoots` (default `["apps", "packages", "plugins", "services", "tools"]`): top-level directories that hold workspaces. A workspace is the first two path segments, such as `packages/ui`. A relative import that lands in a different workspace is flagged.

### no-service-in-tsx

- `servicePaths` (default `["@/lib/services"]`): import prefixes banned in every `.tsx` file.
- `clientOnlyServicePaths` (default `["@/lib/server/services"]`): import prefixes banned only in files that start with a `"use client"` directive, because a server component is the legitimate caller. Type-only imports are always allowed.

### no-date-methods

- `variant` (default `"strict"`): picks a preset list of checks. `"strict"` runs `locale-date-time`, `locale-string-date-named`, `getters`, `setters`, `iso-split`, `new-date-get-time` and `ms-arithmetic`. `"basic"` runs `locale-date-time`, `locale-string-any` and `getters`. An unknown variant throws.
- `checks`: an explicit list of check names that replaces the variant. An unknown name throws.

The checks match these shapes:

- `locale-date-time`: `.toLocaleDateString(` and `.toLocaleTimeString(`.
- `locale-string-any`: any `.toLocaleString(`.
- `locale-string-date-named`: `.toLocaleString(` on a receiver whose name contains `date`, `time` or `at`, since a bare call also formats numbers.
- `getters`: `getMonth`, `getFullYear`, `getDate`, `getDay`, `getHours`, `getMinutes`, `getSeconds` and their UTC forms.
- `setters`: the matching `setDate`, `setMonth`, `setFullYear`, `setHours`, `setMinutes`, `setSeconds` calls and their UTC forms.
- `iso-split`: `.toISOString().split(`.
- `new-date-get-time`: `new Date(...).getTime(`.
- `ms-arithmetic`: multiplication chains such as `* 60 * 1000` and `1000 * 60 * 60`.

## UI

### no-hardcoded-attr-text

Only `.tsx` files are checked.

- `attributes` (default `["aria-label", "placeholder", "title", "alt"]`): JSX attributes whose string values must come from the translation layer. A value needs at least two letters in a row to count.
- `quotes` (default `"any"`): `"any"` accepts single or double quotes and whitespace after the equals sign. `"double"` matches `attr="text"` only. Any other value behaves as `"any"`.
- `ignoreBraces` (default `false`): skip values that contain `{` or `}`.
- `onePerLine` (default `false`): report at most one violation per line.

### no-hardcoded-hex

- `skipLines` (default `["\\bthemeColor\\s*:", "prefers-color-scheme"]`): regular expression sources, and a line matching any of them is skipped. The browser theme color must be a literal and comes as a light and dark pair, which is why the defaults exist. Giving a list replaces them.

### no-inline-styles

No options.

### require-responsive-layout

- `triggers` (default: `grid-cols-N`, `flex-row`, `w-64`, `w-72`, `w-80`, `w-96` and `w-[Npx]` with three or more digits): a list of `{ "pattern": "<regex source>", "label": "<name used in the message>" }` objects.
- `breakpoints` (default `["sm", "md", "lg", "xl", "2xl"]`): prefixes that count as a responsive variant, matched as `sm:` and so on.
- `window` (default `3`): how many lines above and below the trigger line are searched for a breakpoint prefix.

### min-touch-target

- `minSize` (default `48`): minimum hit area in pixels, for both height and width. Tailwind units count as 4 px each.
- `marker` (default `"arch-lint: min-touch-target-ok"`): a comment on the tag's line or the line above that skips the element.
- `inputTypes` (default `["checkbox", "radio", "button", "submit", "reset", "file"]`): input `type` values that are treated as touch targets. An input with any other explicit type is skipped, and an input with no type is checked.

## Data layer

### no-db-outside-models

- `skipLayers` (default `["models"]`): layers allowed to hold database handles. An undefined layer skips nothing.
- `modules` (default `["^drizzle-orm(/|$)", "^(postgres|pg)(/|$)"]`): module specifiers whose value imports and re-exports are flagged.
- `packages` (default: the value of `modules`): module specifiers for which a namespace import (`import * as`), a star re-export or a dynamic import is flagged, which exposes the handles inside.
- `handleNames` (default `["db", "pool"]`): imported or re-exported names treated as database handles from any module.
- `reExports` (default `true`): flag `export ... from` of a database module outside the models layer.

When the config defines a `routes` layer, files in it get a message that says routes must not touch the database.

### no-db-in-routes

- `modules` (default `["^drizzle-orm(/|$)", "^(postgres|pg)(/|$)"]`): module specifiers a route file must not import. Point it at the project's own database package.
- `typeImports` (default `"allow"`): `"flag"` also reports type-only imports.
- `inlineTypeImports` (default `"ignore"`): `"flag"` also reports `import { type Db } from "<db module>"`, where every name is marked `type` inline.

### no-direct-write-audit-in-routes

- `names` (default `["writeAuditEntry"]`): identifiers of the raw audit write primitive. A value import of any of them is flagged, including one on a middle line of a multi-line import list.

### no-cache-in-models

- `modules` (default `["^next/cache$", "^(ioredis|redis|@upstash/redis)(/|$)"]`): module specifiers a model must not import. Type-only imports count too.

### models-stay-below-services

- `modules` (default: a pattern for relative, `@/` and `~/` paths that go through `services`, `workers`, `components`, `queue` or `store`): module specifiers that a model must not import as values.

### tx-required-multi-write

- `skipLayers` (default `[]`): layers whose files are skipped.
- `deferDeleteThenInsert` (default `false`): skip functions whose writes are a delete followed by an insert, leaving them to `tx-delete-then-insert`. Useful for bulk import paths.
- `dbHandles` (default `["db"]`): receiver names whose `insert`, `update` and `delete` calls count as writes.
- `transactionNames` (default `["withTransaction", "runInTransaction"]`): helper names that mark a function as transactional. A call to `<handle>.transaction(` also counts.
- `blockStart` (default `"nested"`): how functions are split. `"top-level"` starts a block only at declarations in column 0. Any other value also starts a block at indented closures and object-literal methods, so a service factory is not read as one function.

### tx-delete-then-insert

Takes `skipLayers`, `dbHandles`, `transactionNames` and `blockStart` with the same meaning and defaults as `tx-required-multi-write`.

### tx-service-orchestration

- `modelsLayer` (default `"models"`) and `servicesLayer` (default `"services"`): the layers that hold model functions and their callers. The rule does nothing unless the config defines both.
- `writeReceivers` (default `["db", "executor", "exec", "tx"]`): receiver names whose `insert`, `update` and `delete` calls make a model function mutating.
- `dbHandles`, `transactionNames` and `blockStart`: same meaning and defaults as in `tx-required-multi-write`. Here they decide which service functions already run in a transaction and where each function ends.

## Migrations

The `migrations` section of the config (`dir`, `journal`, `releaseRef`, `baseRef`) is described in [CONFIG.md](CONFIG.md). When the config names `dir` or `journal` itself and the path does not exist, the rules that read it report that as a violation. A path left at its default is skipped when absent, so a project without migrations is not affected.

### migration-no-tx-control

- `grandfathered` (default `[]`): file base names, such as `0003_old.sql`, that are skipped.

### migration-no-default-privileges-for-role

No options.

### migration-journal-order

- `workingTree` (default `true`): set to `false` to turn off the check in a normal run. The pre-push check is separate and does not read it.
- `report` (default `"per-field"`): `"per-field"` reports `idx` and `when` problems as separate violations, and `"per-entry"` reports one violation per out-of-order entry. Also used by the pre-push check.

### migration-released-immutable

- `workingTree` (default `false`): also compare the working tree's journal with the base ref in a normal run. The pre-push check always runs this comparison.
- `requireBaseAlways` (default `false`): during the pre-push check, read the base ref's journal and fail when it cannot be read, even if none of the pushed refs target the release ref.

### no-drizzle-push

- `files` (default `["package.json"]`): manifests whose `scripts` are read.
- `pattern` (default `drizzle-kit\s+push\b`): regular expression source matched against each script command.

## Hygiene

### no-narration-comments

- `bannedPrefixes` (default `constructor`, `imports`, `return the`, `create a`, `define`, `set the`, `get the`, `end of`, `start the`, `initialize`, `initialise`): a short comment that starts with one of these is flagged. Matching ignores case.
- `maxPrefixWords` (default `5`): the longest comment, in words, that the prefix check applies to.
- `overlapThreshold` (default `0.6`): a comment is flagged when at least this share of its words also appears in the next code line.
- `minOverlapWords` (default `0`): comments with this many words or fewer skip the overlap check. The prefix check still applies.
- `skip` (default `["triple-slash", "todo-tags", "tool-directives", "dividers-dashes", "category-markers"]`): kinds of comment to leave alone. Unknown names are ignored. The kinds are:
  - `triple-slash`: lines starting with `///`.
  - `todo-tags`: `TODO:`, `FIXME:`, `HACK:` and `NOTE:` with the colon, ignoring case.
  - `todo-tags-bare`: the same tags in capitals, with or without a colon.
  - `tool-directives`: `biome-ignore`, `eslint-disable` and `@ts-` comments.
  - `tool-directives-extended`: comments that start with `eslint-`, `prettier-`, `@ts-`, `istanbul` or `biome-`.
  - `dividers`: comments that start with the box-drawing line character.
  - `dividers-dashes`: the same, or a plain hyphen.
  - `category-markers`: comments like `// word.*`.
  - `dash-headers`: comments like `// -- title --`.

### kebab-case-filenames

- `layer`: limit the check to a named layer. The rule's `include` and exemptions apply as well.
- `extensions` (default `[".ts", ".tsx"]`): file extensions that are checked.
- `skipTests` (default `false`): skip files that match the config's `tests` patterns.
- `skipDeclarations` (default `false`): skip `.d.ts` files.

Only uppercase letters in the base name are reported.

### test-file-naming

Off by default.

- `suffixes` (default `.unit.test.ts`, `.fn.test.ts`, `.integration.test.ts`, `.load.test.ts`, `.contract.test.ts`, `.e2e.test.ts`, `.performance.test.ts`): the accepted endings.
- `testFileSuffixes` (default `[".test.ts"]`): which files are subject to the check at all.
- `patterns` (default: the config's `tests` patterns): path patterns that mark test files.
- `skipPathParts` (default `["/setup/"]`): paths containing any of these strings are ignored.

### no-whole-dir-test-script

Off by default. Reads the `test` script of each package manifest and flags a call that would run several test files in one process, when the suite uses a module mock that leaks between files.

- `variant` (default `"strict"`): `"strict"` reads every command separator, skips flag values, and flags bare or multi-file calls. `"basic"` reads `&&` only and flags the first argument that is not a test file.
- `manifests` (default `["**/package.json"]`): path patterns for the manifests to read.
- `script` (default `"test"`): the script name to check.
- `command` (default `"bun test"`): the command whose arguments are inspected.
- `valueFlags` (default `["--timeout", "--env-file", "--preload", "--rerun-each", "-t"]`): flags that take a separate value, so the value is not mistaken for a path. Strict variant only.
- `testFileSuffixes` (default `[".test.ts", ".test.tsx"]`): endings that identify a test file argument and the package's test files.
- `marker` (default `"mock.module"`): text that makes a suite unsafe to run in one process. A package is only checked when one of its test files contains it. An empty string checks every package.

## Clinical logging

These 14 rules read one shared analysis, so they share one option set: `dynamic-module-source-forbidden`, `environment-adapter-required`, `logger-callback-forbidden`, `logger-construction-boundary`, `no-direct-clinical-log-argument`, `no-image-body-upload`, `no-mobile-image-body-upload`, `phi-safe-logger-required`, `phi-safe-mobile-logger-required`, `safe-log-event-required`, `safe-log-scalar-source-required`, `static-log-message`, `static-logger-service` and `tenant-bypass-boundary`.

An option set on any rule of the group applies to all of them. When two rules set the same option, the rule's own value wins. `message` is the exception: it stays per rule. Because the options are merged by rule id, set them under the canonical ids.

Positions in the options below are 1-based `line:column` strings, for example `"6:3"`. A file hash is the SHA-256 of the whole file text, in hex. A change to a pinned file therefore invalidates its approval until the hash is updated.

Identifying the project's logger:

- `eventNames` (default `[]`): the registered log event identifiers, the only messages a logger call may use.
- `corePackage` (default `""`): module specifier of the package that exports the logger factory.
- `loggerModulePattern` (default `""`, which matches nothing): regular expression source matching imports of the project's own logger module.
- `createLoggerExport` (default `"createLogger"`): name of the exported logger factory.
- `redactedWriterExport` (default `"writeRedactedLine"`): name of the exported standalone writer.
- `loggerFactoryFiles` (default `[]`): path patterns of files where the factory may be called. The file named by `coreLoggerFile` may call it too.
- `coreLoggerFile` (default `""`): path of the logger implementation. Its raw writer is approved by hash.
- `coreLoggerSha256` (default `""`): the pinned hash of that file. The raw write inside its top-level `writeLogRecord` function is accepted only while the file's hash matches.
- `coreIndexFile` (default `""`): the package index file that may re-export the factory and the writer.
- `coreIndexSpecifier` (default `"./logger.ts"`): the module specifier that index re-exports them from.

Output and environment rules:

- `unsafeLoggerModules` (default `["bunyan", "pino", "winston"]`): third-party output loggers that are flagged on import. Giving a list replaces the default.
- `envKeyMapperFile` and `envKeyMapperFunction` (default `""`): the file, and the top-level function inside it, that holds the approved key-mapping read of the form `keys.map((key) => process.env[key])`.
- `envChildSpreadFile` and `envChildSpreadFunction` (default `""`): the file, and the top-level function inside it, that holds the approved child-process environment spread, an `env` object that spreads `process.env` next to `PGPASSWORD: password`.
- `rawEnvAllowlist` (default `{}`): approved raw environment reads, shaped `{ "<file>": { "<line:column>": ["ENV_KEY"] } }`.
- `approvedRawFileOutputs` (default `{}`): approved `writeFile` calls, shaped `{ "<file>": { "sha256": "<hash>", "calls": ["<line:column>"] } }`. The calls count only while the file's hash matches.

Log content rules:

- `clinicalTextNames` (default: `accountid`, `accountnumber`, `documenttext`, `driverslicense`, `extractedtext`, `healthcardnumber`, `insuranceid`, `insurancenumber`, `licensenumber`, `medicalrecordnumber`, `memberid`, `mrn`, `ocroutput`, `ocrtext`, `passportnumber`, `patientid`, `patientname`, `patientnumber`, `patientreference`, `policynumber`, `rawocrtext`, `rawtext`, `socialsecuritynumber`, `ssn`, `subscriberid`, `text`, `transcript`): identifier names treated as clinical text. Write them in lowercase letters and digits only. Names are compared after dropping other characters and lowercasing, so `patient_name` matches `patientname`. An empty list matches nothing.
- `operationalScalarFields` (default `{}`): shaped `{ "<event>": ["field"] }`. For these events, the listed fields must come from a reviewed source.
- `safeLogScalarSources` (default `{}`): shaped `{ "<file>:<event>:<field>": { "call": "<line:column>", "expression": "<source text>" } }`. A listed field passes when the logger call sits at that position and the field's expression text matches exactly.
- `approvedLogScalarSourceSha256` (default `{}`): shaped `{ "<file>": "<hash>" }`. The reviewed sources in a file count only while its hash matches.

Layer scoping:

- `tenantBypassLayer` (default `"routes"`): layer where `internalDbNames` identifiers are flagged by `tenant-bypass-boundary`.
- `internalDbNames` (default `[]`): identifiers that give a route an unscoped database handle.
- `imageBodyRouteLayer` (default `"routes"`) and `imageBodyServiceLayer` (default `"services"`): layers where `no-image-body-upload` looks for request body reads and `Blob` or `FormData` construction.
- `mobileUploadLayer` (default `"mobile"`): layer where `no-mobile-image-body-upload` looks for multipart upload types in Dart.

A layer the config does not define turns the scoped check off, so a project that does not use a layer is not affected by its default name.

The rules that use these options most directly:

- `logger-construction-boundary`: `loggerFactoryFiles`, `coreLoggerFile`, `createLoggerExport`.
- `safe-log-event-required`: `eventNames`.
- `safe-log-scalar-source-required`: `operationalScalarFields`, `safeLogScalarSources`, `approvedLogScalarSourceSha256`.
- `no-direct-clinical-log-argument`: `clinicalTextNames`.
- `phi-safe-logger-required`: `unsafeLoggerModules`, `coreLoggerFile`, `coreLoggerSha256`, `approvedRawFileOutputs`.
- `environment-adapter-required`: `rawEnvAllowlist`, the `envKeyMapper*` and `envChildSpread*` options.
- `tenant-bypass-boundary`: `tenantBypassLayer`, `internalDbNames`.
- `no-image-body-upload`: `imageBodyRouteLayer`, `imageBodyServiceLayer`.
- `no-mobile-image-body-upload`: `mobileUploadLayer`.

The other group rules (`dynamic-module-source-forbidden`, `logger-callback-forbidden`, `phi-safe-mobile-logger-required`, `static-log-message`, `static-logger-service`) have no option of their own beyond the identification options above and `message`.

## Flutter

Every Flutter rule reads these three options to decide which Dart files to look at:

- `root` (default `""`): directory of the Dart project, relative to the repository root.
- `sourceDirs` (default `["lib/"]`): directories below `root` that are scanned.
- `skipSuffixes` (default `[".g.dart"]`): file endings that are skipped, such as generated code.

### no-dash

Uses only the three shared options. Flags en and em dashes in code and comments.

### no-ui-toolkit

- `nonUiDirs` (default `lib/data/`, `lib/domain/`, `lib/sync/`, `lib/repositories/`, `lib/auth/`, `lib/core/`, `lib/api/`): directories below `root` that must not import a UI toolkit.
- `uiToolkits` (default `["package:flutter/material.dart", "package:flutter/cupertino.dart"]`): import targets that are flagged there.

### no-feature-import

- `nonUiDirs`: same as in `no-ui-toolkit`.
- `featureDir` (default `"lib/features/"`): the screen directory that non-UI code must not import. An empty string turns the rule off.
- `packageName` (default: the `name:` from `pubspec.yaml` under `root`): the package name used to resolve `package:<name>/` imports into paths. Without a name only relative imports resolve.

### no-store-in-features

- `featureDir`: same as in `no-feature-import`, including the empty string turning the rule off.
- `storeImportPattern` (default `(^|/)objectbox\.g\.dart$`): regular expression source for import targets that count as the store.
- `storeCallPattern` (default `\.box<\w+>\(\)`): regular expression source for calls that count as using the store directly. Comment lines are skipped.

### no-hardcoded-origin

- `allowedUrlPattern` (default `https://(play\.google\.com|apps\.apple\.com)/`): a line that matches is allowed to hold an origin, which keeps store links out of the findings. Exempt the one environment helper that owns server origins through `exempt.files`.
