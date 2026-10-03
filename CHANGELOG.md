# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) once the project reaches 1.0.

## [Unreleased]

### Added

- `arch-lint` CLI with `lint`, `format`, `format:write`, `fix`, `arch`, `check`, `codeflow` and `init`.
- Bundled ESLint 9 and Prettier 3 setups that defer to a project's own config when it has one.
- Architecture rule engine with 59 rules, layers, per-rule exemptions and options, a baseline for tolerated debt, and rule presets.
- Biome compatibility: a `biome.json` or `biome.jsonc` is mapped onto the bundled ESLint and Prettier, including when a project config wraps `createConfig` (`biome: false` opts out), with the settings that cannot be mapped printed once to stderr.
- Python support: `lint`, `format`, `format:write`, `fix` and `check` run ruff and mypy in the Python projects they find, with `--no-python` and `--python-only`. A missing ruff or mypy fails the command unless `"python": { "required": false }` is set. Named paths reach only the tools that handle them, and ESLint output flags keep Python out so machine output stays parseable.
- Headless CodeFlow analysis, report, hotspots, finding checks and audit.
