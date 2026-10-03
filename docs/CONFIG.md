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

| Field          | Meaning                                                                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extends`      | Configs merged underneath this one, in order. `preset:<name>` is a built-in from `src/presets/`, anything else is a path relative to the file.             |
| `scan`         | Directories, files or globs to read. Default `["."]`. Dangling symlinks are skipped.                                                                       |
| `ignore`       | Extra path patterns to skip. `node_modules`, `.git`, `.next`, `.turbo`, `.codeflow`, `dist`, `build` and `coverage` are always skipped.                    |
| `tests`        | Patterns that mark test files, which source rules skip. Default: `tests/` and `test/` directories, `*.test.*`, `*.spec.*`.                                 |
| `layers`       | Named groups of path patterns. Rules can be limited to a layer. A layer name the config never defines matches every path.                                  |
| `defaultLevel` | Level for rules the config does not list. `"off"` runs only the rules you list.                                                                            |
| `rules`        | Per rule: a level (`"error"` or `"off"`) or an object with `level`, `layer`, `include`, `exempt`, `options`.                                               |
| `baseline`     | File of tolerated violation counts per rule and file. Default `arch-lint.baseline.json`.                                                                   |
| `migrations`   | `dir`, `journal`, `releaseRef` and `baseRef` for the migration rules. Defaults: `drizzle`, `drizzle/meta/_journal.json`, `refs/heads/main`, `origin/main`. |

Path patterns: `dir/` matches everything below `dir`, a plain path matches that file, and `*`, `?`, `**` and `{a,b}` work as globs.

When configs are merged (`extends`), later values win per key, exemption lists accumulate, and `scan`, `tests` and layers are replaced by name rather than appended.

## Rule settings

- `layer`: limit the rule to a named layer. Each rule has its own default layer, listed in [RULES.md](RULES.md).
- `include`: extra patterns the rule is limited to.
- `exempt.files` and `exempt.dirs`: exact files and path prefixes the rule skips.
- `options`: rule specific. Every rule accepts `message` to replace its text. The rest are listed in [RULE-OPTIONS.md](RULE-OPTIONS.md).

Older rule ids keep working. For example `no-console-log` is an alias of `no-console`, and baselines that still use the older id are mapped on read.

## Commands

```sh
arch-lint arch                      # run every enabled rule
arch-lint arch --rule no-any,no-raw-throw
arch-lint arch --all                # also show baselined debt per rule
arch-lint arch --update-baseline    # record current violations as tolerated
arch-lint arch --journal            # pre-push migration journal check (reads git's pre-push stdin)
arch-lint arch --list               # every rule
arch-lint arch --config other.json  # a config file, relative to --cwd
```

Exit code 1 means a violation that is not in the baseline.
