# How arch-lint works

arch-lint has three parts that share one package: a command line that wraps ESLint and Prettier, an architecture rule engine, and headless CodeFlow analysis. This page covers the rule engine, since that is the part with the most moving pieces.

## A run, start to finish

`arch-lint arch` calls `src/arch/index.ts` with the project directory as the root. The steps:

1. **Load the config** (`config.ts`). `arch-lint.config.json` is read, any `extends` are merged underneath it (`preset:<name>` loads from `src/presets/`), and the result is resolved into defaults. A project with no config file gets the `recommended` preset.
2. **List files** (`files.ts`). The `scan` entries are walked, skipping ignored paths. Source files are the `.ts` and `.tsx` files that are not declarations or tests. Rules that need other files, such as migrations or Dart sources, ask for them through the project context.
3. **Run the rules** (`run.ts`). Each enabled rule runs over the files it applies to. File rules see one file at a time. Project rules see the whole tree.
4. **Apply the baseline** (`baseline.ts`). Violations that match the tolerated counts in the baseline file are reported as debt, not as failures.
5. **Report** (`report.ts`). Violations are grouped by rule and the exit code is 1 if any are new.

## Rules

There are two kinds, both defined in `src/arch/types.ts`:

- A **file rule** has `check(file, ctx)` and returns violations for one file. Most rules are this kind.
- A **project rule** has `check(ctx)` and sees the whole tree through `ctx.files`, `ctx.listFiles()` and `ctx.read()`. Migration checks, file naming and rules that compare several files are this kind.

Every rule has a canonical `id`, may have older `aliases` that configs and baselines can still use, and a one-line `description` that ends up in `docs/RULES.md`.

Rules do not know about exemptions or scope. The runner applies, in order: the rule's level (`off` skips it), its layer, any `include` patterns, and `exempt.files` and `exempt.dirs`. That keeps project specific lists out of rule code and in configuration where they belong.

## Layers

A layer is a named group of path patterns in the config: `backend`, `routes`, `models`, `components` and so on. A rule can have a default layer (for example a rule about thrown errors defaults to `backend`) and a config can point a rule at a different one. A layer the config never defines matches every path, so a rule with a default layer still works in a project that has not defined layers yet.

## Options

Each rule reads its options from the config through `option(ctx, "name", fallback)`. Every rule accepts `message` to replace its text. The options a rule supports are listed in [RULE-OPTIONS.md](RULE-OPTIONS.md).

## The registry

`src/arch/registry.ts` collects the rules from the groups under `src/arch/rules/` and fails at load time if two rules claim the same id or alias. `arch-lint arch --list` prints what it found.

## CodeFlow

`src/codeflow/core.js` is the analyzer, lifted unchanged from the upstream CodeFlow project and run inside a Node `vm` context. `src/codeflow/lib/` feeds it files and `src/codeflow/headless/` turns its output into reports: `analyze` copies tracked files to a scratch directory (rewriting path aliases from `tsconfig.json`), runs the analyzer and writes JSON, a full markdown report, blast radii and churn hotspots. `verify` re-checks the analyzer's dead-code and structure findings against the files on disk. `audit` writes those results up.

## Lint and format

`arch-lint lint` and `arch-lint format` run the ESLint and Prettier that ship with the package. If the project has its own configuration (this directory or any parent), that is used and the bundled one is not. Otherwise the bundled configs in `src/configs/` apply. When the project has a `biome.json`, whether it uses the bundled configs or wraps `createConfig` in its own, `src/configs/biome-compat.mjs` reads it and both bundled configs derive their options, rules and ignores from it; see [BIOME.md](BIOME.md).

Python projects are handled by `src/commands/python.mjs`. `lint`, `format` and `fix` call it after the JavaScript tools. It finds the project roots from their config files, resolves ruff and mypy per root, and runs them with the root as the working directory. See [LANGUAGES.md](LANGUAGES.md).

## Git workflow

`src/commands/staged.mjs` lists the staged files through `src/git.mjs` and calls the same `lint`, `format` and `arch` functions the other commands use, so routing by file type stays in one place. `commit-msg.mjs` is a pure check of a message file against the `commit` config. `hooks.mjs` generates the three hook scripts from the project's config and compares them with what is on disk, and `ci.mjs` builds the workflow file. The `hooks`, `commit` and `migrations` sections they read come from the project's own `arch-lint.config.json` through `readProjectConfig` in `src/util.mjs`, not through `extends`. See [HOOKS.md](HOOKS.md).
