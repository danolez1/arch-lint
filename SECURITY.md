# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting instead: go to the repository's Security tab and choose "Report a vulnerability". That sends the report only to the maintainers.

Include what you found, the version (`arch-lint --version`), how to reproduce it, and what you think the impact is. You will get an acknowledgement within a few days. Fixes are released as a patch version and credited in the changelog unless you would rather stay anonymous.

## What is in scope

- The `arch-lint` CLI and the packages it ships.
- Anything that lets a crafted repository, config file or source file run code, read or write files outside the project, or leak data when arch-lint is run on it. The `codeflow` commands copy files into a temporary directory and run an analyzer over them, so path handling there matters.

## What is not

- Rules reporting a false positive or a false negative. Those are ordinary bugs; open an issue.
- Problems that need an attacker who can already edit your `arch-lint.config.json` or your `package.json` scripts.

## Supported versions

Only the latest release gets fixes while the project is on 0.x.
