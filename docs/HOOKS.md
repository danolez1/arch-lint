# Git hooks, commit messages and CI

arch-lint can wire its checks into git. The generic parts live in the package: a staged-file check, a pre-push check with the migration journal, a commit message check, an installer for the hooks and a CI workflow. Anything specific to your project (audits, builds, tests, cleanup) stays in your project and is added through config.

```sh
npx arch-lint hooks install      # writes .githooks/ and points git at it
npx arch-lint init --ci          # writes .github/workflows/arch-lint.yml
```

## What each hook runs

| Hook         | Steps, in order                                                                                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | `arch-lint staged`, then each command in `hooks.preCommit`.                                                                                                                                                                        |
| `pre-push`   | Read git's ref lines into `$refs`. When `migrations.dir` or `migrations.journal` is set: fetch the base ref, then `arch-lint arch --journal` with the refs piped in. Then `arch-lint check`, then each command in `hooks.prePush`. |
| `commit-msg` | `arch-lint commit-msg "$1"`.                                                                                                                                                                                                       |

Every hook is a `#!/bin/sh` script with `set -e`, mode 755.

### staged

`arch-lint staged` lists the staged files (`git diff --cached --name-only --diff-filter=ACMR -z`, so files staged for deletion are left out) and routes them the way `lint` and `format` route paths:

- JavaScript and TypeScript files (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`) go to ESLint.
- Every file Prettier supports goes to the Prettier check, which includes those JavaScript and TypeScript files, JSON, CSS, Markdown and YAML.
- `.py` and `.pyi` files go to ruff (lint and format check). mypy still checks its whole project, as it does for `lint`.
- Anything else is ignored.

After that the architecture rules run over the whole project, because most rules compare files with each other. `--no-arch` leaves them out.

By default it only checks and never rewrites a file. Every step runs even if an earlier one failed, so one run shows all the problems, and the exit code is 1 if any step failed. With nothing staged it prints one line and exits 0.

`--fix` runs the fixing variants instead (`eslint --fix`, `prettier --write`, `ruff format`). It changes the working tree only and stages nothing, so run `git add` again afterwards. The files it changed are printed. `--no-python` and `--python-only` work as they do for `lint`.

The checks read the files on disk, not the staged blobs, so they can only vouch for what will be committed when the two are the same. If a staged file also has unstaged changes (`git diff --name-only -z`), `staged` stops before running anything, lists those files on stderr, and exits 1:

```
arch-lint staged: these files have changes that are not staged, so the checks would not see what will be committed: src/a.ts
Stage them (git add) or stash the rest (git stash --keep-index), or pass --allow-partial to check the working tree copies anyway.
```

`--allow-partial` runs the checks on the working tree copies anyway and prints the same list as a warning on stderr. `git commit -a` and `git commit <paths>` stage those files first, so the hook sees nothing partial there.

A file that is staged but no longer in the working tree (for example you staged it and then deleted it by hand) has nothing to check. It is left out of ESLint, Prettier and ruff, and one note on stderr names it.

### pre-push and the migration journal

`git push` writes one line per pushed ref to the hook's stdin. The hook reads them once, before any other step can consume them, and keeps them in `$refs`. When migrations are configured it then fetches the base ref quietly:

```sh
git fetch --no-tags --quiet origin +refs/heads/main:refs/remotes/origin/main
```

The refspec follows `migrations.baseRef` (default `origin/main`, which gives the remote and the tracking branch) and `migrations.releaseRef` (default `refs/heads/main`, the branch on the remote). If the fetch fails, for example offline, the hook prints a note to stderr and carries on with the last fetched copy. The refs then go to `arch-lint arch --journal`.

The `migrations` section is read from the project's own `arch-lint.config.json`, like `hooks` and `commit`.

`$refs` is available to the commands in `hooks.prePush`.

### commit-msg

`arch-lint commit-msg <file>` checks the first line that is not a comment. See [CONFIG.md](CONFIG.md#commit-messages) for the settings. Errors print one line each to stderr and exit 1. Warnings (an unknown scope with the default `scopeLevel`) print to stderr and exit 0.

Two things are not part of the message and are skipped, as git itself does: everything from the scissors line (`# ------------------------ >8 ------------------------`) onward, which `git commit -v` fills with the diff, and comment lines. A comment is a line whose `#` is followed by whitespace or ends the line, so `# Changes to be committed:` is a comment while `#123 fix: x` is content. Other comment characters (`core.commentChar`) are not honored.

```
$ git commit -m "Added a thing."
commit-msg: header must look like type(scope): subject
```

## Config

Both sections go in `arch-lint.config.json`, and both are read from that file only, not through `extends`.

```json
{
  "migrations": {
    "dir": "db/migrations",
    "journal": "db/migrations/meta/_journal.json"
  },
  "hooks": {
    "preCommit": ["node scripts/audit-deps.mjs"],
    "prePush": ["pnpm test", "pnpm build"]
  },
  "commit": {
    "scopes": ["api", "web", "db", "deps"],
    "scopeLevel": "warn",
    "forbidTrailers": ["^generated with"]
  }
}
```

`hooks.preCommit` and `hooks.prePush` are lists of single line shell commands. They are copied into the scripts, so reinstall after changing them.

## Worked example

A pnpm project (it has a `pnpm-lock.yaml`) with the config above. `arch-lint hooks install` writes:

`.githooks/pre-commit`:

```sh
#!/bin/sh
# Written by arch-lint hooks install. Change the commands in arch-lint.config.json and install again.
set -e
pnpm exec arch-lint staged
node scripts/audit-deps.mjs
```

`.githooks/pre-push`:

```sh
#!/bin/sh
# Written by arch-lint hooks install. Change the commands in arch-lint.config.json and install again.
set -e
# git sends the ref lines once on stdin, so read them before another step can consume them.
refs=$(cat)
# Offline pushes still run the other checks; the migration check then reads the last fetched copy.
git fetch --no-tags --quiet origin +refs/heads/main:refs/remotes/origin/main || echo "pre-push: fetch failed, using the last fetched origin/main" >&2
printf '%s\n' "$refs" | pnpm exec arch-lint arch --journal
pnpm exec arch-lint check
pnpm test
pnpm build
```

`.githooks/commit-msg`:

```sh
#!/bin/sh
# Written by arch-lint hooks install. Change the commands in arch-lint.config.json and install again.
set -e
pnpm exec arch-lint commit-msg "$1"
```

## Installing

```sh
arch-lint hooks install [--husky] [--dir <path>] [--force] [--runner npx|bunx|pnpm]
arch-lint hooks status
```

- The default writes `.githooks/pre-commit`, `pre-push` and `commit-msg`, and runs `git config core.hooksPath .githooks` for the repository. Run it at the repository root.
- `--dir <path>` writes to another directory.
- A value flag must be followed by its value. `--dir --force` is a usage error (exit 2) instead of a directory named `--force`. A value that really starts with a dash can be written as `--dir=-name`.
- If `core.hooksPath` is already set to a different directory, install does not take it over. It writes nothing, names the current value on stderr and exits 1. `--force` replaces the setting and the output says what it was: `core.hooksPath set to .githooks (was custom-hooks)`. A value that resolves to the same directory (`./.githooks`, an absolute path) is fine.
- In a linked worktree `core.hooksPath` is shared with the main checkout and every other worktree. Installing there with a `--dir` outside the worktree is refused the same way unless you pass `--force`.
- The runner prefix comes from the lockfile: `bunx --no-install` when there is a `bun.lock` or `bun.lockb`, `pnpm exec` when there is a `pnpm-lock.yaml`, otherwise `npx --no-install`. `--runner` overrides it.
- An existing hook with different content is not touched, and the command names it and exits 1 without writing anything. `--force` replaces it. Running the install again on unchanged files changes nothing.
- `hooks status` prints the value of `core.hooksPath`, whether git reads the inspected directory, and for each hook whether it is up to date, missing, not executable, or differs from what install would write now (for example after you edited `hooks` in the config). It exits 0 only when every hook is up to date and git reads the directory. A missing, edited or non-executable hook, or a `core.hooksPath` that does not point at the directory, makes it exit 1, so it can run in CI or a setup script. `--husky`, `--dir` and `--runner` work as for install.

### Husky

```sh
arch-lint hooks install --husky
```

writes `.husky/pre-commit`, `pre-push` and `commit-msg` with the same contents and leaves `core.hooksPath` alone. It does not create husky's bootstrap files, so husky has to be installed in the project (`npm i -D husky`, then run `husky` from a `prepare` script) for the hooks to run. If `core.hooksPath` is already set to a directory other than `.husky` or husky's `.husky/_`, git will not read these files, and install says so on stderr (it still exits 0). `hooks status --husky` treats `.husky/_` as reading `.husky`, and exits 1 until git does.

## CI

`arch-lint init --ci` writes `.github/workflows/arch-lint.yml`: checkout, `actions/setup-node` with Node 20, an install step chosen from the lockfile, then `npx arch-lint check`.

| Lockfile                  | Install step                                              |
| ------------------------- | --------------------------------------------------------- |
| `package-lock.json`       | `npm ci`                                                  |
| `pnpm-lock.yaml`          | `corepack enable`, then `pnpm install --frozen-lockfile`  |
| `bun.lock` or `bun.lockb` | `oven-sh/setup-bun`, then `bun install --frozen-lockfile` |
| none of these             | `npm install`                                             |

When migrations are configured the workflow also fetches the base ref before the check, because a pull request checkout does not carry it. An existing workflow file is left alone unless it is identical or you pass `--force`. `init --hooks` runs the hooks install after the normal `init` and passes `--husky`, `--dir`, `--runner` and `--force` on to it. A value flag with no value is rejected before `init` writes anything.

## Skipping the hooks in an emergency

```sh
git commit --no-verify
git push --no-verify
```

`--no-verify` skips pre-commit and commit-msg on a commit, and pre-push on a push. CI still runs the same checks, so use it to get unstuck, not to avoid a failing rule.
