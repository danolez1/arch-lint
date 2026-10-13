# Configuration

The architecture rules read `arch-lint.config.json` in the project root. Without one, the `recommended` preset applies (a handful of broadly useful rules, everything else off).

```json
{
  "extends": ["preset:recommended"],
  "scan": ["src", "packages/*/src"],
  "ignore": ["**/generated/**"],
  "layers": {
    "backend": ["services/", "packages/"],
    "routes": ["**/routes/**"]
  },
  "defaultLevel": "off",
  "rules": {
    "no-raw-throw": {
      "layer": "backend",
      "exempt": { "files": ["scripts/seed.ts"], "dirs": ["tools/"] }
    },
    "no-any": { "options": { "variant": "basic" } },
    "code-clone": {
      "level": "error",
      "options": { "minTokens": 50, "minLines": 6 }
    }
  },
  "baseline": "arch-lint.baseline.json"
}
```

## Fields

| Field                 | Meaning                                                                                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extends`             | Configs merged underneath this one, in order. `preset:<name>` is a built-in from `src/presets/`, anything else is a path relative to the file.                                                |
| `scan`                | Directories, files or globs to read. Default `["."]`. Dangling symlinks are skipped.                                                                                                          |
| `ignore`              | Extra path patterns to skip. `node_modules`, `.git`, `.next`, `.turbo`, `.codeflow`, `dist`, `build` and `coverage` are always skipped.                                                       |
| `tests`               | Patterns that mark test files, which source rules skip. Default: `tests/` and `test/` directories, `*.test.*`, `*.spec.*`.                                                                    |
| `layers`              | Named groups of path patterns. Rules can be limited to a layer. A layer name the config never defines matches every path.                                                                     |
| `allowedDependencies` | Map a source layer to the only target layers it may import. Omit a source layer to leave its dependencies unrestricted.                                                                       |
| `contexts`            | Optional groups of layers with `name`, `layers`, and `public` lists. A cross-context import may target only a public layer.                                                                   |
| `teams`               | Map team names to the layers they own. A layer can belong to one team. Used by team boundary and mismatch checks.                                                                             |
| `abstractLayers`      | Layer names treated as abstract by the stability-distance check.                                                                                                                              |
| `graph`               | Graph settings: `coChange` enables co-change analysis; `coChangeThreshold` is its minimum co-change count (default `3`).                                                                      |
| `adrDir`              | Markdown directory for executable architecture directives. Default: `docs/adr`. Set to `""` to disable ADR directives.                                                                        |
| `defaultLevel`        | Level for rules the config does not list. `"off"` runs only the rules you list.                                                                                                               |
| `rules`               | Per rule: a level (`"error"` or `"off"`) or an object with `level`, `layer`, `include`, `exempt`, `options`.                                                                                  |
| `baseline`            | File storing tolerated findings. Default `arch-lint.baseline.json`.                                                                                                                           |
| `baselineMode`        | `"identity"` (default) matches stable identities when provided; `"worsening"` compares raw values for findings with numeric metrics. See below.                                               |
| `python`              | A missing ruff or mypy fails `lint`, `format`, `format:write`, `fix` and `check` with exit code 1. `{ "required": false }` skips it with a message instead. See [LANGUAGES.md](LANGUAGES.md). |
| `migrations`          | `dir`, `journal`, `releaseRef` and `baseRef` for the migration rules. Defaults: `drizzle`, `drizzle/meta/_journal.json`, `refs/heads/main`, `origin/main`.                                    |
| `hooks`               | `{ "preCommit": [], "prePush": [] }`: shell commands the generated git hooks run after arch-lint's own steps. See [HOOKS.md](HOOKS.md).                                                       |
| `commit`              | Rules for `arch-lint commit-msg`: `types`, `scopes`, `scopeLevel`, `requireScope`, `maxHeaderLength`, `forbidTrailers`. See the section below.                                                |

`python`, `hooks` and `commit` are read from the project's own `arch-lint.config.json` only. They are not merged in through `extends`, so a preset or a shared config cannot set them.

Path patterns: `dir/` matches everything below `dir`, a plain path matches that file, and `*`, `?`, `**` and `{a,b}` work as globs.

When configs are merged (`extends`), later values win per key, exemption lists accumulate, and `scan`, `tests` and layers are replaced by name rather than appended.

## Built-in presets

Use `"extends": ["preset:<name>"]` to add a built-in config. The framework presets extend `recommended`, enable `circular-dependency` and `unused-export`, and list common framework entry points so exported route and component files are not treated as unused.

| Preset    | Framework | Entry point patterns                                                              |
| --------- | --------- | --------------------------------------------------------------------------------- |
| `nestjs`  | NestJS    | `*.module.ts`, `*.controller.ts`, `*.gateway.ts`, `*.resolver.ts`, `main.ts`      |
| `nextjs`  | Next.js   | `app/**/page.*`, `layout.*`, `route.*`, `template.*`, `pages/**`                  |
| `express` | Express   | `routes/**`, route and router files, controllers, `app.*`, `server.*`             |
| `react`   | React     | `App.*`, `app/**`, `pages/**`, `main.*`                                           |
| `vue`     | Vue       | TypeScript and JavaScript files under `views/`, `pages/`, `router/`, and `main.*` |
| `angular` | Angular   | `*.module.ts`, `*.component.ts`, `*.routes.ts`, routing modules, `main.ts`        |

These presets configure rules only. They do not add framework parsing or scan Vue single-file components (`.vue`); put the script in a matching JavaScript or TypeScript file for graph and structural analysis. You can extend one of these presets and override its rule settings in your project config.

## Baseline matching

The default `identity` mode matches stable finding identities when a rule provides them. Message edits alone do not create a fresh finding for those identities. Findings without a stable identity use their rule, file, and message as the match key. Set `baselineMode` to `worsening` to store raw values for findings that expose numeric metrics. A new metric, a changed worsening direction, or a value moving in the configured worse direction becomes fresh. When the same metric and direction remain, unchanged or improved values remain debt. Message edits alone do not count as regressions in this mode.

```json
{
  "baselineMode": "worsening"
}
```

Run `arch-lint arch --update-baseline` after changing modes. It writes a version 5 baseline that records the selected mode and, in `worsening` mode, the current metric values. Populated version 2 and 3 baselines remain usable in `identity` mode, though version 3 retains historical message-sensitive matching for non-metric findings until refreshed. `worsening` mode requires refreshing populated version 2 or 3 baselines. A populated version 4 baseline, or a populated version 5 baseline created in the other mode, also requires a refresh before scanning.

## Executable architecture decisions

Architecture Decision Records can declare graph layers and dependency rules in fenced `archlint` blocks. By default, the graph check reads Markdown files under `docs/adr`; set `adrDir` to another directory or to `""` to disable this input.

````md
```archlint
layer service = src/service/
layer db = src/db/
allow service -> db
deny db -> service
```
````

`layer` adds path patterns to a layer, and `allow` or `deny` sets a dependency between two layers. Lines starting with `#` and blank lines are ignored. ADR layers extend the configured `layers`; ADR `allow` rules extend `allowedDependencies`. A `deny` that conflicts with an allowed dependency fails with the ADR location, so the written decision and configuration cannot silently disagree.

## Rule settings

- `layer`: limit the rule to a named layer. Each rule has its own default layer, listed in [RULES.md](RULES.md).
- `include`: extra patterns the rule is limited to.
- `exempt.files` and `exempt.dirs`: files and path prefixes the rule skips. `exempt.files` takes exact paths or globs such as `**/*.test.tsx`.
- `options`: rule specific. Every rule accepts `message` to replace its text. The rest are listed in [RULE-OPTIONS.md](RULE-OPTIONS.md).

`code-clone` and `dead-symbols` are off by default. `code-clone` reports exact repeated TypeScript or JavaScript statement runs and skips configured test files and declaration files. `dead-symbols` reports private functions, classes, and variables with no in-project references; exported and ambient declarations are skipped. See [RULES.md](RULES.md) and [RULE-OPTIONS.md](RULE-OPTIONS.md) for details.

Older rule ids keep working. For example `no-console-log` is an alias of `no-console`, and baselines that still use the older id are mapped on read.

## Hooks

```json
{
  "hooks": {
    "preCommit": ["node scripts/audit.mjs"],
    "prePush": ["npm test", "npm run build"]
  }
}
```

Each entry is one single line shell command. `arch-lint hooks install` writes them into the hook scripts after the built-in steps, in the order given. Reinstall after changing them. [HOOKS.md](HOOKS.md) covers what each hook runs.

## Commit messages

```json
{
  "commit": {
    "types": ["feat", "fix", "docs", "chore"],
    "scopes": ["api", "web", "db"],
    "scopeLevel": "warn",
    "requireScope": false,
    "maxHeaderLength": 100,
    "forbidTrailers": ["^generated with", "^signed-off-by:"]
  }
}
```

| Key               | Meaning                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `types`           | Allowed types. Default `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.              |
| `scopes`          | Known scopes. Unset or empty means any scope is accepted. A comma separated scope such as `deps,ci` is checked part by part.      |
| `scopeLevel`      | `"warn"` (default) prints a warning to stderr and passes, `"error"` fails the commit.                                             |
| `requireScope`    | Fail a header that has no scope. Default `false`.                                                                                 |
| `maxHeaderLength` | Longest allowed first line. Default `100`.                                                                                        |
| `forbidTrailers`  | Regular expression sources, matched case-insensitively against every line of the message. A match fails the commit. Default none. |

The first line must read `type(scope)!: subject`, with a lower case type, a non-empty subject and no trailing period. Merge, revert, fixup and squash commits skip the header rules, but `forbidTrailers` still applies to them. Comment lines (a `#` followed by whitespace, or alone on the line) and everything after the scissors line that `git commit -v` adds are ignored, so `#123 fix: x` counts as text.

## Commands

```sh
arch-lint arch                      # run every enabled rule
arch-lint arch --rule no-any,no-raw-throw
arch-lint arch --all                # also show baselined debt per rule
arch-lint arch --update-baseline    # record current violations as tolerated
arch-lint arch --journal            # pre-push migration journal check (reads git's pre-push stdin)
arch-lint arch --journal --base-absent  # the same for a remote with no release ref yet, skipping the released comparison
arch-lint arch --list               # every rule
arch-lint arch --config other.json  # a config file, relative to --cwd
arch-lint staged [--fix] [--no-arch] [--allow-partial]  # lint and format the staged files, then the rules
arch-lint commit-msg <file>         # check a commit message file
arch-lint hooks install | status    # git hooks, see HOOKS.md
```

A completed scan exits with code 1 when it finds at least one violation outside the baseline.
