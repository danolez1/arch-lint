# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) once the project reaches 1.0.

## [Unreleased]

### Added

- `arch-lint` CLI with `lint`, `format`, `format:write`, `fix`, `arch`, `check`, `codeflow` and `init`.
- Bundled ESLint 9 and Prettier 3 setups that defer to a project's own config when it has one.
- Architecture rule engine with 59 rules, layers, per-rule exemptions and options, a baseline for tolerated debt, and rule presets.
- Headless CodeFlow analysis, report, hotspots, finding checks and audit.
