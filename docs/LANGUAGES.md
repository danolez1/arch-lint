# Languages

What each command does depends on the language. JavaScript and Python are handled by their own tools, the architecture rules read TypeScript and Dart, and CodeFlow has its own list of languages.

| Language                    | Tools                   | `lint`                                             | `format`                | `format:write`     | `fix`                                      |
| --------------------------- | ----------------------- | -------------------------------------------------- | ----------------------- | ------------------ | ------------------------------------------ |
| JavaScript, TypeScript, JSX | ESLint, Prettier        | `eslint`                                           | `prettier --check`      | `prettier --write` | `eslint --fix`, then `prettier --write`    |
| JSON, CSS, Markdown         | Prettier                | nothing                                            | `prettier --check`      | `prettier --write` | `prettier --write`                         |
| Python                      | ruff, mypy              | `ruff check .`, then `mypy .` where mypy is set up | `ruff format --check .` | `ruff format .`    | `ruff check --fix .`, then `ruff format .` |
| Dart                        | architecture rules only | nothing                                            | nothing                 | nothing            | nothing                                    |

`check` runs `lint` and `format` for the languages above that have tools, then the architecture rules (`arch`). Dart files are only read by the `arch` rules for the mobile projects.

CodeFlow (`arch-lint codeflow`) is separate. It has its own set of analyzer languages, wider than this table, and it never runs ESLint, Prettier, ruff or mypy.

## Python

ESLint and Prettier ship inside this package. ruff and mypy do not, because they come from Python and there is no npm package for them. Install them with `pip`, `pipx` or `uv`, or let `uv` fetch ruff on demand.

### Finding Python projects

A Python project root is a directory under the one you run in that holds one of:

- `ruff.toml` or `.ruff.toml`, or a `pyproject.toml` with a `[tool.ruff` table. ruff runs there.
- a `pyproject.toml` with a `[tool.mypy` table, or a `mypy.ini`, `.mypy.ini` or `setup.cfg` with a `[mypy` section. mypy runs there.

A monorepo can have several roots, one per service. Each tool runs once per root with that root as its working directory. A nested ruff root is not run a second time by its parent: ruff already uses the nearest config for every file, so a ruff root inside another ruff root is covered by the outer run. mypy roots are independent. A mypy config inside another mypy root still runs on its own directory, with its own config, because mypy reads exactly one config per run.

The scan skips `node_modules`, `.git`, `.venv`, `venv`, `__pycache__`, `.tox`, `dist`, `build`, `.next` and `.turbo`. In a git repository it asks git for the file list instead, so anything the `.gitignore` ignores is skipped as well. A project with no Python config files starts no Python process.

### Which executable runs

Looked up per root, in this order:

| Tool | 1st                          | 2nd                                                                                                       | 3rd                                      | 4th             |
| ---- | ---------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------- |
| ruff | `.venv/bin/ruff` in the root | `ruff` on `PATH`                                                                                          | `uv tool run ruff`, if `uv` is installed | none: see below |
| mypy | `.venv/bin/mypy` in the root | `uv run --directory <root> mypy`, if `uv` is installed and the root has a `uv.lock` or a `[tool.uv` table | `mypy` on `PATH`                         | none: see below |

`uv run` is preferred for a uv project so that mypy sees the project's locked dependencies.

### When nothing is found

A missing tool is an error, so a Python project cannot pass `lint` or `format` just because ruff or mypy is not installed. The command prints one line per root and tool and exits with code 1:

```
arch-lint: python: ruff not found for service-a. Install ruff or uv, or set "python": { "required": false } in arch-lint.config.json to skip.
```

A root that sits at the project root reads "for the project root". The other roots still run before the command fails.

To skip a missing tool instead, with one line on stderr and the command still passing, set this in `arch-lint.config.json`:

```json
{ "python": { "required": false } }
```

The skipped line then reads `arch-lint: python: ruff not found for service-a, skipped. Install ruff or uv.` A project with no Python roots is never affected by `required`.

### Paths and flags

- Each path you name goes only to the tools that handle it. A path ending in `.py` or `.pyi` goes to ruff and is removed from the ESLint and Prettier arguments. A path with any other file extension is never given to ruff. A directory goes to every tool.
- A tool that has no path left does not run. `arch-lint format service-a/app.py` runs ruff only, and Prettier is not started or given `.` instead.
- `lint [paths]` and `format [paths]` limit ruff to the paths that point inside a Python root. A path that points at a parent of several roots runs all of them. A path that matches no root, such as `src`, starts no Python process.
- mypy always runs on its root directory and ignores path arguments, because a partial run misses what the other files declare. A path inside a mypy root starts mypy for that root, and the run still checks the whole root (`mypy .`).
- `lint --fix` and `fix` run `ruff check --fix`. mypy has no fix mode, so it is left out of those two.
- When `lint` is given an ESLint output flag (`-f`, `--format`, `-o`, `--output-file`, also in the `=` form), ruff and mypy do not run and write nothing to stdout, so ESLint's report stays parseable. One line on stderr says Python was skipped. Run `lint --python-only` separately to check Python.
- `--no-python` leaves Python out of `lint`, `format`, `format:write`, `fix` and `check`.
- `--python-only` runs only Python and leaves ESLint and Prettier out. With `check` it also leaves out the architecture rules.
- The two flags cannot be used together, and neither is passed on to ESLint or Prettier.
- The exit code is non-zero when any step fails. Steps after a failure still run, so one run reports everything.
