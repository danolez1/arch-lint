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

## Commands

| Command                      | What it does                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| `arch-lint lint [paths]`     | ESLint. Extra flags pass straight through (`--fix`, `--max-warnings 0`).                               |
| `arch-lint format [paths]`   | Prettier `--check`.                                                                                    |
| `arch-lint format:write`     | Prettier `--write`.                                                                                    |
| `arch-lint fix`              | `lint --fix`, then `format:write`.                                                                     |
| `arch-lint arch`             | The architecture rules. `--rule a,b`, `--all`, `--update-baseline`, `--journal`, `--list`, `--config`. |
| `arch-lint check`            | `lint`, `format` and `arch` in sequence. `--skip-arch` leaves the rules out.                           |
| `arch-lint codeflow analyze` | Headless CodeFlow: analysis, full report, blast radii, churn hotspots. Writes into `.codeflow/`.       |
| `arch-lint codeflow verify`  | Re-checks CodeFlow's dead code and structure findings against the files on disk.                       |
| `arch-lint codeflow audit`   | Turns an analysis and its verdicts into a written audit.                                               |
| `arch-lint init [--force]`   | Adds the scripts above and an `arch-lint.config.json`.                                                 |

`--cwd <dir>` runs any command against another project directory.

## Configuration

- ESLint: a project `eslint.config.*` (this directory or a parent) is used as is. Otherwise the bundled config applies. It detects `next` in `package.json` and switches to `eslint-config-next`, and adds the React hooks rules when `react` is a dependency.
- Prettier: a project config (`.prettierrc*`, `prettier.config.*`, a `prettier` key; this directory or a parent) wins. Without one the bundled config applies (double quotes, semicolons, width 80, ES5 trailing commas, organize-imports).
- Architecture rules: `arch-lint.config.json`. See [docs/CONFIG.md](docs/CONFIG.md) for the format, [docs/RULES.md](docs/RULES.md) for the 59 rules and [docs/RULE-OPTIONS.md](docs/RULE-OPTIONS.md) for their options.
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
docs/                    CONFIG, RULES, RULE-OPTIONS, ARCHITECTURE, WRITING-RULES
tests/                   CLI, rule and CodeFlow tests
```

## Status

Early. The architecture rules come from several separate projects and were merged into the one engine in `src/arch/`. The merged rules are tested against the original test suites, but a few behaviors were tightened on purpose (comment lines starting with `/*` or `*` are skipped, some patterns gained word boundaries); see the rule source for details.

Only JavaScript and TypeScript are linted for now (plus Dart for the mobile rules). CodeFlow itself reads many more languages.

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
