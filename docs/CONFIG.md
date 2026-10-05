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
    "no-any": { "options": { "variant": "basic" } }
  },
  "baseline": "arch-lint.baseline.json"
}
```

## Fields

| Field          | Meaning                                                                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extends`      | Configs merged underneath this one, in order. `preset:<name>` is a built-in from `src/presets/`, anything else is a path relative to the file.                                                |
| `scan`         | Directories, files or globs to read. Default `["."]`. Dangling symlinks are skipped.                                                                                                          |
| `ignore`       | Extra path patterns to skip. `node_modules`, `.git`, `.next`, `.turbo`, `.codeflow`, `dist`, `build` and `coverage` are always skipped.                                                       |
| `tests`        | Patterns that mark test files, which source rules skip. Default: `tests/` and `test/` directories, `*.test.*`, `*.spec.*`.                                                                    |
| `layers`       | Named groups of path patterns. Rules can be limited to a layer. A layer name the config never defines matches every path.                                                                     |
| `defaultLevel` | Level for rules the config does not list. `"off"` runs only the rules you list.                                                                                                               |
| `rules`        | Per rule: a level (`"error"` or `"off"`) or an object with `level`, `layer`, `include`, `exempt`, `options`.                                                                                  |
| `baseline`     | File of tolerated violation counts per rule and file. Default `arch-lint.baseline.json`.                                                                                                      |
| `python`       | A missing ruff or mypy fails `lint`, `format`, `format:write`, `fix` and `check` with exit code 1. `{ "required": false }` skips it with a message instead. See [LANGUAGES.md](LANGUAGES.md). |
| `migrations`   | `dir`, `journal`, `releaseRef` and `baseRef` for the migration rules. Defaults: `drizzle`, `drizzle/meta/_journal.json`, `refs/heads/main`, `origin/main`.                                    |
| `hooks`        | `{ "preCommit": [], "prePush": [] }`: shell commands the generated git hooks run after arch-lint's own steps. See [HOOKS.md](HOOKS.md).                                                       |
| `commit`       | Rules for `arch-lint commit-msg`: `types`, `scopes`, `scopeLevel`, `requireScope`, `maxHeaderLength`, `forbidTrailers`. See the section below.                                                |

`python`, `hooks` and `commit` are read from the project's own `arch-lint.config.json` only. They are not merged in through `extends`, so a preset or a shared config cannot set them.

Path patterns: `dir/` matches everything below `dir`, a plain path matches that file, and `*`, `?`, `**` and `{a,b}` work as globs.

When configs are merged (`extends`), later values win per key, exemption lists accumulate, and `scan`, `tests` and layers are replaced by name rather than appended.

## Rule settings

- `layer`: limit the rule to a named layer. Each rule has its own default layer, listed in [RULES.md](RULES.md).
- `include`: extra patterns the rule is limited to.
- `exempt.files` and `exempt.dirs`: files and path prefixes the rule skips. `exempt.files` takes exact paths or globs such as `**/*.test.tsx`.
- `options`: rule specific. Every rule accepts `message` to replace its text. The rest are listed in [RULE-OPTIONS.md](RULE-OPTIONS.md).

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

Exit code 1 means a violation that is not in the baseline.
