# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) once the project reaches 1.0.

## [Unreleased]

## [0.1.0] - 2026-10-05

### Added

- `scripts/sync-codeflow.mjs` to re-lift the analyzer core from an upstream CodeFlow checkout, and a test that fails when a released rule id or alias disappears.
- `arch-lint` CLI with `lint`, `format`, `format:write`, `fix`, `arch`, `check`, `codeflow` and `init`.
- Bundled ESLint 9 and Prettier 3 setups that defer to a project's own config when it has one.
- Architecture rule engine with 59 rules, layers, per-rule exemptions and options, a baseline for tolerated debt, and rule presets.
- Biome compatibility: a `biome.json` or `biome.jsonc` is mapped onto the bundled ESLint and Prettier, including when a project config wraps `createConfig` (`biome: false` opts out), with the settings that cannot be mapped printed once to stderr.
- Python support: `lint`, `format`, `format:write`, `fix` and `check` run ruff and mypy in the Python projects they find, with `--no-python` and `--python-only`. A missing ruff or mypy fails the command unless `"python": { "required": false }` is set. Named paths reach only the tools that handle them, and ESLint output flags keep Python out so machine output stays parseable.
- Headless CodeFlow analysis, report, hotspots, finding checks and audit.
- Git workflow tooling: `staged` (lint and format checks on staged files, then the rules), `commit-msg` (conventional commits with scope warnings and optional banned trailers), `hooks install` and `hooks status` (plain `.githooks` or `--husky`), `init --ci` for a GitHub Actions workflow and `init --hooks`. The `hooks` and `commit` config sections are described in `docs/CONFIG.md` and `docs/HOOKS.md`.
- `hooks install` refuses to replace an existing `core.hooksPath` that points at another directory, and refuses to rewrite the shared config from a linked worktree for a directory outside it, unless `--force` is given. `--husky` warns on stderr when git is configured to read another directory.
- `staged` fails when a staged file also has unstaged changes, naming the files, unless `--allow-partial` is given. A staged file that is missing from the working tree is skipped with a note instead of being handed to ESLint and Prettier.
- `commit-msg` ignores everything from the scissors line that `git commit -v` adds, and treats `#` as a comment only when whitespace follows it, so `#123 fix: x` is content.
- `hooks status` exits 1 when a hook is missing, differs or is not executable, or when git is not reading the hooks directory.
- A value flag followed by another flag (for example `hooks install --dir --force`) is a usage error, and `init --hooks` forwards `--husky`, `--dir`, `--runner` and `--force` to the installer.
- The pre-push hook tells an empty remote (no release ref yet) from a failed fetch with `git ls-remote --exit-code`: the first push of `main` is no longer blocked, the journal order check still runs and the released-migration comparison is skipped (`arch --journal --base-absent`), and a failed fetch with no local base ref now says so instead of claiming a last fetched copy.
