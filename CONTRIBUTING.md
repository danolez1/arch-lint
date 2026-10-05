# Contributing

Thanks for looking at arch-lint. Bug reports, rule ideas, docs fixes and code are all welcome.

## Getting set up

You need Node 20.9 or newer. Bun is optional.

```sh
git clone https://github.com/danolez1/arch-lint.git
cd arch-lint
npm ci
npm test
```

`npm test` runs the CLI tests, the rule tests and the CodeFlow suite (about 600 tests, under a minute). Before you open a pull request, these should all pass:

```sh
npm run typecheck
npm run lint
npm run format      # npm run format:write fixes what it finds
npm test
```

The repo lints and formats itself with its own CLI, so a failing `npm run lint` is the same thing a user of the package would see.

## Where things live

- `src/bin.mjs`, `src/cli.mjs`, `src/commands/`: the command line.
- `src/arch/`: the architecture rule engine. `src/arch/rules/` holds the rules, grouped by topic.
- `src/codeflow/`: headless CodeFlow. `core.js`, `lib/` and `analyze.js` are lifted from the upstream project and are kept as they are; changes to the analyzer itself belong upstream.
- `src/configs/`, `src/presets/`: the bundled ESLint and Prettier configs and the rule presets.
- `docs/`: user docs. `docs/RULES.md` is generated, so edit the rule's description in code and run `npm run docs:rules`.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how a run flows through the engine, and [docs/WRITING-RULES.md](docs/WRITING-RULES.md) walks through adding a rule.

## Proposing a change

1. For anything bigger than a small fix, open an issue first so we can agree on the shape before you spend time on it.
2. Keep a pull request to one concern. A new rule, a bug fix and a refactor are three pull requests.
3. Add tests. A rule needs a test for what it flags, what it leaves alone, and each option it has. A bug fix needs a test that fails without the fix.
4. Update the docs if behavior or options changed.

## Code style

- TypeScript is strict. No `any` in rule code.
- Comments say why, not what. If the code is clear, leave it uncommented.
- Rules import only Node built-ins and `typescript`. Anything else needs a good reason and an issue first.
- Rule messages are plain sentences and name no company or project. Anything project specific (paths, exemptions, names) is configuration, never rule code.

## Commits

Small commits with a short imperative subject (`fix: skip dangling symlinks`, `feat: add no-foo rule`). Explain the reason in the body when it is not obvious.

## Releasing

Releases are cut by a maintainer. `npm run release:check` is the gate: it checks the working tree, runs typecheck, lint, format and all tests, inspects what `npm pack` would ship, scans tracked files for the banned phrase, dashes, home paths and secrets, confirms the version is unpublished, and installs a packed tarball from a clean export under npm (and bun when present). `prepublishOnly` runs it again. A `.release-denylist` file (git-ignored, one regular expression per line) adds private names to the scan. Tag the release as `vX.Y.Z`; the publish workflow checks the tag against `package.json`.

## Reporting bugs

Use the bug report template. The most useful report has the command you ran, your `arch-lint.config.json` (trimmed), the output, and the smallest file that reproduces it.

Security problems go through the process in [SECURITY.md](SECURITY.md), not a public issue.

By contributing you agree your work is released under the MIT license that covers the project.
