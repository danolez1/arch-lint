# arch-lint

One install that gives a project ESLint, Prettier, architecture lint rules and headless CodeFlow analysis.

```sh
npm i -D arch-lint        # or: bun add -d arch-lint
npx arch-lint init        # adds scripts and arch-lint.config.json
```

After `init` the usual commands work:

```sh
bun lint                  # npm run lint also works
bun run lint:fix
bun run format            # prettier check
bun run format:write      # prettier write
bun run arch-lint         # architecture rules
bun run check             # lint + format + architecture rules, one exit code for CI
bun run codeflow          # headless CodeFlow analysis into .codeflow/
```

ESLint, Prettier, typescript-eslint, the React hooks plugin, `eslint-config-next` and the organize-imports Prettier plugin ship as dependencies of this package. Nothing else needs installing. Node 20.9 or newer is enough, Bun is not required.

The package is not published yet. Until it is, install it from a tarball (`npm pack`) or a path.

### Installing with pnpm

pnpm 11 stops with `ERR_PNPM_IGNORED_BUILDS` (and exits 1 on every later `pnpm install`) when a dependency has an install script the project has not approved. Two of this package's dependencies have one, `esbuild` and `unrs-resolver`. Neither script is needed, because the platform binaries come as separate packages, so tell pnpm to skip them in `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  esbuild: false
  unrs-resolver: false
```

Checked with pnpm 11.6.0: `lint`, `format`, the architecture rules and `check` all work with both scripts off. `pnpm add --ignore-scripts` also avoids the error. Other pnpm versions are untested. npm and Bun only print a notice and exit 0.

## Commands

| Command                       | What it does                                                                                                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `arch-lint lint [paths]`      | ESLint, plus `ruff check` and mypy in Python projects. Extra flags pass to ESLint (`--fix`, `--max-warnings 0`).                                                                |
| `arch-lint format [paths]`    | Prettier `--check`, plus `ruff format --check`.                                                                                                                                 |
| `arch-lint format:write`      | Prettier `--write`, plus `ruff format`.                                                                                                                                         |
| `arch-lint fix`               | `lint --fix`, then `format:write`.                                                                                                                                              |
| `arch-lint arch`              | The architecture rules. `--rule a,b`, `--all`, `--update-baseline`, `--journal`, `--list`, `--config`.                                                                          |
| `arch-lint check`             | `lint`, `format` and `arch` in sequence. `--skip-arch` leaves the rules out.                                                                                                    |
| `arch-lint codeflow analyze`  | Headless CodeFlow: analysis, full report, blast radii, churn hotspots. Writes into `.codeflow/`.                                                                                |
| `arch-lint codeflow verify`   | Re-checks CodeFlow's dead code and structure findings against the files on disk.                                                                                                |
| `arch-lint codeflow audit`    | Turns an analysis and its verdicts into a written audit.                                                                                                                        |
| `arch-lint staged`            | The lint and format checks on the staged files only, then the rules. `--fix` rewrites, `--no-arch` skips rules, `--allow-partial` checks files that also have unstaged changes. |
| `arch-lint commit-msg <file>` | Checks a commit message: conventional commits, scope warnings, optional banned trailers.                                                                                        |
| `arch-lint hooks install`     | Writes pre-commit, pre-push and commit-msg hooks into `.githooks/` (`--husky` for `.husky/`). `hooks status` compares and exits 1 if anything is off.                           |
| `arch-lint init [--force]`    | Adds the scripts above and an `arch-lint.config.json`. `--ci` writes a GitHub Actions workflow, `--hooks` installs the git hooks.                                               |

`--cwd <dir>` runs any command against another project directory.

The git hooks, the commit message check and the CI workflow are covered in [docs/HOOKS.md](docs/HOOKS.md).

`--no-python` leaves Python out of `lint`, `format`, `format:write`, `fix` and `check`.
`--python-only` runs only the Python tools in those same commands.

Python projects (a `ruff.toml`, or a `pyproject.toml` with `[tool.ruff` or `[tool.mypy`) are found by scanning the tree. ruff and mypy are not bundled, since they come from Python: they are used from `.venv/bin`, `PATH` or `uv`, and a missing one fails the command unless `"python": { "required": false }` is set, which skips it with a message. See [docs/LANGUAGES.md](docs/LANGUAGES.md).

## Configuration

- ESLint: a project `eslint.config.*` (this directory or a parent) is used as is. Otherwise the bundled config applies. It detects `next` in `package.json` and switches to `eslint-config-next`, and adds the React hooks rules when `react` is a dependency.
- Prettier: a project config (`.prettierrc*`, `prettier.config.*`, a `prettier` key; this directory or a parent) wins. Without one the bundled config applies (double quotes, semicolons, width 80, ES5 trailing commas, organize-imports).
- Biome: a project with a `biome.json` (or `biome.jsonc`) gets that file mapped onto the bundled configs, whether it uses them directly or wraps `createConfig` in its own config (`biome: false` opts out): formatter options become Prettier options, rule levels and overrides become ESLint rules and blocks, and ignore patterns reach both. Settings with no equivalent are printed once to stderr. See [docs/BIOME.md](docs/BIOME.md).
- Architecture rules: `arch-lint.config.json`. See [docs/CONFIG.md](docs/CONFIG.md) for the format, [docs/RULES.md](docs/RULES.md) for the 59 rules and [docs/RULE-OPTIONS.md](docs/RULE-OPTIONS.md) for their options. [docs/CONVENTIONS.md](docs/CONVENTIONS.md) is the guide the rules enforce.
- To extend the bundled lint configs from your own files:

```js
// eslint.config.mjs
import { createConfig } from "arch-lint/eslint";
export default await createConfig({ ignores: ["generated/**"], rules: {} });
```

```js
// prettier.config.mjs
export { default } from "arch-lint/prettier";
```

## Layout

```
src/                     everything that runs
  bin.mjs cli.mjs commands/ util.mjs   the CLI
  configs/ presets/            bundled ESLint and Prettier configs, rule presets
  arch/                        the architecture rule engine: runner, config, 59 rules
  codeflow/                    headless CodeFlow: analyzer core, headless/ (analyze, report, hotspots, verify, audit)
docs/                    CONFIG, HOOKS, RULES, RULE-OPTIONS, CONVENTIONS, ARCHITECTURE, WRITING-RULES, LANGUAGES, BIOME
tests/                   CLI, rule and CodeFlow tests
```

## Status

Early. The architecture rules come from several separate projects and were merged into the one engine in `src/arch/`. The merged rules are tested against the original test suites, but a few behaviors were tightened on purpose (comment lines starting with `/*` or `*` are skipped, some patterns gained word boundaries), and options restore the older matching where it matters; see [docs/RULE-OPTIONS.md](docs/RULE-OPTIONS.md). Until 1.0, rule ids, option names and config keys are not removed; a rename keeps the old name as an alias.

Tested on macOS and Linux with Node 20, 22 and 24. On `windows-latest` (Node 22) typecheck, lint and format pass, and 683 of the 744 tests pass; the failures are in the git hooks and Python tests, whose generated scripts and test stand-ins assume `sh`, plus three tests around Biome and path handling. Treat Windows as unsupported for now, and expect the hooks to need Git for Windows' `sh`. Reports from Windows users are welcome.

Linted languages: JavaScript, TypeScript and the other formats Prettier supports through ESLint and Prettier, Python through ruff and mypy, and Dart through the architecture rules only. CodeFlow itself reads many more languages. See [docs/LANGUAGES.md](docs/LANGUAGES.md).

## Development

```sh
npm test                  # CLI, rule and CodeFlow tests
npm run typecheck
npm run docs:rules        # regenerate docs/RULES.md from the rule registry
```

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Please read the [code of conduct](CODE_OF_CONDUCT.md), and report security problems through [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

MIT, see [LICENSE](LICENSE). CodeFlow is MIT licensed, copyright 2026 Braedon Saunders (upstream: github.com/braedonsaunders/codeflow). See `src/codeflow/LICENSE`.
