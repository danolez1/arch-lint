import { readFileSync } from "node:fs";
import path from "node:path";
import { UsageError, readProjectConfig } from "../util.mjs";

const DEFAULT_TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

const SKIPPED_HEADER = /^(?:Merge |Revert "|(?:fixup|squash|amend)! )/;
// git commit -v puts the diff after this line, and git drops it from the message.
const SCISSORS = /^#\s*-+\s*>8\s*-+\s*$/;
// Like git's default cleanup, a comment needs whitespace after the #, so "#123 fix" stays content.
const COMMENT = /^#(?:\s|$)/;
const HEADER = /^(?<type>[^\s():!]+)(?:\((?<scope>[^()]*)\))?!?:(?<rest>.*)$/;

function stringList(value, name) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new UsageError(
      `arch-lint.config.json: commit.${name} must be an array of strings`
    );
  }
  return value;
}

function settingsFrom(root) {
  const commit = readProjectConfig(root).commit ?? {};
  if (typeof commit !== "object" || Array.isArray(commit)) {
    throw new UsageError("arch-lint.config.json: commit must be an object");
  }
  const scopeLevel = commit.scopeLevel ?? "warn";
  if (scopeLevel !== "warn" && scopeLevel !== "error") {
    throw new UsageError(
      'arch-lint.config.json: commit.scopeLevel must be "warn" or "error"'
    );
  }
  const maxHeaderLength = commit.maxHeaderLength ?? 100;
  if (!Number.isInteger(maxHeaderLength) || maxHeaderLength < 1) {
    throw new UsageError(
      "arch-lint.config.json: commit.maxHeaderLength must be a positive integer"
    );
  }
  return {
    types: commit.types ? stringList(commit.types, "types") : DEFAULT_TYPES,
    scopes: commit.scopes ? stringList(commit.scopes, "scopes") : [],
    scopeLevel,
    requireScope: commit.requireScope === true,
    maxHeaderLength,
    forbidTrailers: stringList(
      commit.forbidTrailers ?? [],
      "forbidTrailers"
    ).map((source) => {
      try {
        return new RegExp(source, "i");
      } catch (err) {
        throw new UsageError(
          `arch-lint.config.json: commit.forbidTrailers has an invalid pattern: ${err.message}`
        );
      }
    }),
  };
}

function checkHeader(header, settings, problems) {
  const { errors, warnings } = problems;
  if (header.length > settings.maxHeaderLength) {
    errors.push(
      `header is ${header.length} characters, the limit is ${settings.maxHeaderLength}`
    );
  }
  const match = HEADER.exec(header);
  if (!match) {
    errors.push("header must look like type(scope): subject");
    return;
  }
  const { type, scope, rest } = match.groups;

  if (type !== type.toLowerCase()) {
    errors.push(`type "${type}" must be lower case`);
  }
  if (!settings.types.includes(type.toLowerCase())) {
    errors.push(
      `type "${type}" is not allowed, use one of: ${settings.types.join(", ")}`
    );
  }

  if (scope !== undefined) {
    const parts = scope.split(",").map((part) => part.trim());
    if (parts.some((part) => part === "")) {
      errors.push("scope must not be empty");
    } else if (settings.scopes.length > 0) {
      const unknown = parts.filter((part) => !settings.scopes.includes(part));
      if (unknown.length > 0) {
        const text = `scope "${unknown.join(", ")}" is not one of: ${settings.scopes.join(", ")}`;
        (settings.scopeLevel === "error" ? errors : warnings).push(text);
      }
    }
  } else if (settings.requireScope) {
    errors.push("scope is required");
  }

  if (rest !== "" && !rest.startsWith(" ")) {
    errors.push("a space is needed after the colon");
  }
  const subject = rest.trim();
  if (subject === "") errors.push("subject must not be empty");
  else if (subject.endsWith(".")) {
    errors.push("subject must not end with a period");
  }
}

export function checkMessage(text, settings) {
  const problems = { errors: [], warnings: [] };
  const all = text.split(/\r?\n/);
  const cut = all.findIndex((line) => SCISSORS.test(line));
  const lines = (cut === -1 ? all : all.slice(0, cut))
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => !COMMENT.test(line));

  const first = lines.find(({ line }) => line.trim() !== "");
  if (!first) {
    problems.errors.push("commit message is empty");
    return problems;
  }

  // Skipping covers the header rules only, so a banned trailer cannot ride in on a fixup or merge.
  if (!SKIPPED_HEADER.test(first.line)) {
    checkHeader(first.line.trimEnd(), settings, problems);
  }
  for (const { line, number } of lines) {
    for (const pattern of settings.forbidTrailers) {
      if (pattern.test(line)) {
        problems.errors.push(
          `line ${number} matches the forbidden pattern /${pattern.source}/`
        );
      }
    }
  }
  return problems;
}

export async function commitMsg(argv, { root }) {
  if (argv.length !== 1) {
    throw new UsageError("commit-msg needs the path of the message file");
  }
  const file = path.resolve(root, argv[0]);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new UsageError(`Cannot read ${file}: ${err.message}`);
  }

  const { errors, warnings } = checkMessage(text, settingsFrom(root));
  for (const warning of warnings) {
    process.stderr.write(`commit-msg: warning: ${warning}\n`);
  }
  for (const error of errors) process.stderr.write(`commit-msg: ${error}\n`);
  return errors.length > 0 ? 1 : 0;
}
