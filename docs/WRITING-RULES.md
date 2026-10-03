# Writing a rule

A rule is a small object with an id, a description and a `check` function. This page builds one end to end.

## 1. Decide the kind

Does the rule need only one file at a time? Write a file rule. Does it compare files, read files that are not source (SQL, JSON, Dart) or look at the tree layout? Write a project rule. See [ARCHITECTURE.md](ARCHITECTURE.md).

## 2. Write it

Rules live in `src/arch/rules/`, grouped by topic. Add yours to the group it fits, or start a new group file and import it in `src/arch/registry.ts`.

The simplest file rule flags lines that match a pattern. `patternRule` does that, skipping comment lines:

```ts
import { patternRule } from "./util";

export const noEval = patternRule({
  id: "no-eval",
  description: "Do not call eval.",
  pattern: /\beval\s*\(/,
  message: "Parse the data instead of evaluating it.",
});
```

Because `patternRule` skips comments, a rule about comments needs a hand written check:

```ts
import type { FileRule, Violation } from "../types";
import { violation } from "./util";

export const noTodoWithoutIssue: FileRule = {
  kind: "file",
  id: "no-todo-without-issue",
  description: "A TODO comment must point at an issue.",
  check(file) {
    const found: Violation[] = [];
    file.lines.forEach((line, index) => {
      if (/\/\/.*\bTODO\b(?!\(#\d+\))/.test(line)) {
        found.push(
          violation(
            file.path,
            index + 1,
            "no-todo-without-issue",
            "Write TODO(#123) so the work can be found."
          )
        );
      }
    });
    return found;
  },
};
```

Things to keep in mind:

- Report `index + 1` as the line number. Use `file.code` (comments blanked) when you want to ignore comments and strings that look like code, and `file.text` or `file.lines` when you want them.
- Do not hardcode paths, folder names or project names. Take them as options (`option(ctx, "name", fallback)`) or let the runner scope the rule with layers and `include`.
- Support `message` through `messageFor(ctx, defaultText)` so projects can change the wording.
- Set `defaultLayer` if the rule only makes sense in one part of a codebase, and `defaultLevel: "off"` if it should be opt in.

## 3. Register it

Export it from the group's `RULES` array. The registry picks it up from there.

## 4. Test it

Tests use Node's built-in runner and the helpers in `tests/arch/helpers.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { check } from "./helpers";

test("flags a TODO with no issue", async () => {
  const found = await check(
    "no-todo-without-issue",
    "src/a.ts",
    "// TODO fix this\n"
  );
  assert.deepEqual(
    found.map((v) => v.line),
    [1]
  );
});

test("accepts a TODO with an issue", async () => {
  const found = await check(
    "no-todo-without-issue",
    "src/a.ts",
    "// TODO(#12) fix\n"
  );
  assert.equal(found.length, 0);
});
```

`check(ruleId, path, text, { options, settings, config, files })` runs the rule through the real pipeline, so layers, exemptions and options behave as they do for users. Use `checkProject` for project rules with several files. Cover what the rule flags, what it leaves alone, and each option.

Run one file with `node --import tsx --test tests/arch/your-file.test.ts`.

## 5. Document it

Run `npm run docs:rules` to refresh `docs/RULES.md`. Add the rule's options to `docs/RULE-OPTIONS.md`.
