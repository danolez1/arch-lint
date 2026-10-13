import { createHash } from "node:crypto";
import ts from "typescript";
import { matchesAny } from "../paths";
import type { ProjectContext, ProjectRule, Violation } from "../types";
import { option, positiveInteger } from "./util";

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

interface CloneBlock {
  file: string;
  blockStart: number;
  line: number;
  start: number;
  end: number;
  tokenCount: number;
  lineCount: number;
  signature: string;
  statements: {
    tokens: string[];
    start: number;
    end: number;
    startLine: number;
    endLine: number;
  }[];
  firstStatement: number;
  lastStatement: number;
}

interface RepeatedRun {
  file: string;
  line: number;
  start: number;
  end: number;
  coverageStart: number;
  tokenCount: number;
  lineCount: number;
  repetitions: number;
  signature: string;
}

function fullyCovered(
  candidate: CloneBlock,
  ranges: { start: number; end: number }[]
): boolean {
  let coveredUntil = candidate.start;
  for (const range of ranges.sort((left, right) => left.start - right.start)) {
    if (range.end <= coveredUntil) continue;
    if (range.start > coveredUntil) return false;
    coveredUntil = range.end;
    if (coveredUntil >= candidate.end) return true;
  }
  return false;
}

function nonoverlappingOccurrences(candidates: CloneBlock[]): CloneBlock[] {
  const unique = new Map<string, CloneBlock>();
  for (const candidate of candidates) {
    const key = `${candidate.file}:${candidate.start}:${candidate.end}`;
    unique.set(key, candidate);
  }
  const groupedByFile = new Map<string, CloneBlock[]>();
  for (const candidate of unique.values()) {
    const sameFile = groupedByFile.get(candidate.file);
    if (sameFile) sameFile.push(candidate);
    else groupedByFile.set(candidate.file, [candidate]);
  }
  const occurrences: CloneBlock[] = [];
  for (const sameFile of groupedByFile.values()) {
    sameFile.sort((left, right) => left.start - right.start);
    let lastEnd = -1;
    for (const candidate of sameFile)
      if (candidate.start >= lastEnd) {
        occurrences.push(candidate);
        lastEnd = candidate.end;
      }
  }
  return occurrences;
}

function sameTokens(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((token, index) => token === right[index])
  );
}

function expandPair(
  left: CloneBlock,
  right: CloneBlock,
  minTokens: number,
  minLines: number
): CloneBlock[] {
  let leftFirst = left.firstStatement;
  let rightFirst = right.firstStatement;
  let leftLast = left.lastStatement;
  let rightLast = right.lastStatement;
  while (
    leftFirst > 0 &&
    rightFirst > 0 &&
    sameTokens(
      left.statements[leftFirst - 1]!.tokens,
      right.statements[rightFirst - 1]!.tokens
    )
  ) {
    leftFirst--;
    rightFirst--;
  }
  while (
    leftLast + 1 < left.statements.length &&
    rightLast + 1 < right.statements.length &&
    sameTokens(
      left.statements[leftLast + 1]!.tokens,
      right.statements[rightLast + 1]!.tokens
    )
  ) {
    leftLast++;
    rightLast++;
  }
  const expanded: CloneBlock[] = [];
  for (const [candidate, first, last] of [
    [left, leftFirst, leftLast],
    [right, rightFirst, rightLast],
  ] as const) {
    const firstStatement = candidate.statements[first]!;
    const lastStatement = candidate.statements[last]!;
    const tokens = candidate.statements
      .slice(first, last + 1)
      .flatMap((statement) => statement.tokens);
    const lineCount = lastStatement.endLine - firstStatement.startLine + 1;
    if (tokens.length < minTokens || lineCount < minLines) continue;
    expanded.push({
      file: candidate.file,
      blockStart: candidate.blockStart,
      line: firstStatement.startLine + 1,
      start: firstStatement.start,
      end: lastStatement.end,
      tokenCount: tokens.length,
      lineCount,
      signature: JSON.stringify(tokens),
      statements: candidate.statements,
      firstStatement: first,
      lastStatement: last,
    });
  }
  return expanded;
}

function expandOccurrences(
  candidates: CloneBlock[],
  minTokens: number,
  minLines: number
): CloneBlock[] {
  const occurrences = nonoverlappingOccurrences(candidates);
  const groupedByBlock = new Map<string, CloneBlock[]>();
  for (const candidate of occurrences) {
    const key = `${candidate.file}:${candidate.blockStart}`;
    const sameBlock = groupedByBlock.get(key);
    if (sameBlock) sameBlock.push(candidate);
    else groupedByBlock.set(key, [candidate]);
  }
  const blocks = [...groupedByBlock.values()];
  const expanded: CloneBlock[] = [];
  for (let blockIndex = 1; blockIndex < blocks.length; blockIndex++) {
    const left = blocks[0]!;
    const right = blocks[blockIndex]!;
    const leftCovered: { start: number; end: number }[] = [];
    const rightCovered: { start: number; end: number }[] = [];
    let rightIndex = 0;
    for (const leftCandidate of left) {
      if (fullyCovered(leftCandidate, leftCovered)) continue;
      while (
        rightIndex < right.length &&
        fullyCovered(right[rightIndex]!, rightCovered)
      )
        rightIndex++;
      if (rightIndex >= right.length) break;
      const pair = expandPair(
        leftCandidate,
        right[rightIndex]!,
        minTokens,
        minLines
      );
      rightIndex++;
      if (
        pair.length !== 2 ||
        (pair[0]!.file === pair[1]!.file &&
          pair[0]!.start < pair[1]!.end &&
          pair[1]!.start < pair[0]!.end)
      )
        continue;
      expanded.push(...pair);
      leftCovered.push({ start: pair[0]!.start, end: pair[0]!.end });
      rightCovered.push({ start: pair[1]!.start, end: pair[1]!.end });
    }
  }
  return expanded;
}

function leafTokens(node: ts.Node, source: ts.SourceFile): ts.Node[] {
  const tokens: ts.Node[] = [];
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const children = current.getChildren(source);
    if (children.length === 0) {
      if (current.getWidth(source) > 0) tokens.push(current);
      continue;
    }
    for (let index = children.length - 1; index >= 0; index--)
      pending.push(children[index]!);
  }
  return tokens;
}

function statementTokens(
  statement: ts.Statement,
  source: ts.SourceFile
): string[] {
  return leafTokens(statement, source).map(
    (token) => `${token.kind}:${token.getText(source)}`
  );
}

function collectBlocks(
  ctx: ProjectContext,
  minTokens: number,
  minLines: number
): { blocks: CloneBlock[]; repeatedRuns: RepeatedRun[] } {
  const blocks: CloneBlock[] = [];
  const repeatedRuns: RepeatedRun[] = [];
  for (const file of ctx.listFiles(SOURCE_EXTENSIONS)) {
    if (/\.d\.(?:ts|mts|cts)$/.test(file) || matchesAny(file, ctx.config.tests))
      continue;
    const text = ctx.read(file);
    if (text === null) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      /\.(?:jsx|tsx)$/.test(file)
        ? ts.ScriptKind.TSX
        : /\.(?:js|mjs|cjs)$/.test(file)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS
    );
    const visit = (node: ts.Node) => {
      if (ts.isBlock(node)) {
        const statements = node.statements.map((statement) => ({
          statement,
          tokens: statementTokens(statement, source),
          start: statement.getStart(source),
          end: statement.getEnd(),
          startLine: source.getLineAndCharacterOfPosition(
            statement.getStart(source)
          ).line,
          endLine: source.getLineAndCharacterOfPosition(statement.getEnd())
            .line,
        }));
        for (let start = 0; start < statements.length;) {
          let end = start;
          while (
            end + 1 < statements.length &&
            sameTokens(statements[start]!.tokens, statements[end + 1]!.tokens)
          )
            end++;
          if (end > start) {
            const repeated = statements.slice(start + 1, end + 1);
            const tokens = repeated.flatMap((statement) => statement.tokens);
            const firstRepeated = repeated[0]!;
            const lastRepeated = repeated.at(-1)!;
            const lineCount =
              lastRepeated.endLine - firstRepeated.startLine + 1;
            if (tokens.length >= minTokens && lineCount >= minLines)
              repeatedRuns.push({
                file,
                line: firstRepeated.startLine + 1,
                start: firstRepeated.start,
                end: lastRepeated.end,
                coverageStart: statements[start]!.start,
                tokenCount: tokens.length,
                lineCount,
                repetitions: end - start + 1,
                signature: JSON.stringify(tokens),
              });
          }
          start = end + 1;
        }
        const remainingTokens = new Array<number>(statements.length + 1).fill(
          0
        );
        for (let index = statements.length - 1; index >= 0; index--)
          remainingTokens[index] =
            remainingTokens[index + 1]! + statements[index]!.tokens.length;
        const blockStart = node.getStart(source);
        const blockStartLine =
          source.getLineAndCharacterOfPosition(blockStart).line;
        const blockEndLine = source.getLineAndCharacterOfPosition(
          node.getEnd()
        ).line;
        const blockLineCount = blockEndLine - blockStartLine + 1;
        const fullBlockTokens = leafTokens(node, source).map(
          (token) => `${token.kind}:${token.getText(source)}`
        );
        for (let start = 0; start < statements.length; start++) {
          const wrapperTokens = start === 0 ? 2 : 0;
          if (remainingTokens[start]! + wrapperTokens < minTokens) break;
          const first = statements[start]!;
          const maximumLineCount =
            start === 0
              ? blockLineCount
              : statements.at(-1)!.endLine - first.startLine + 1;
          if (maximumLineCount < minLines) break;
          const tokens: string[] = [];
          let wholeBlockAdded = false;
          for (let end = start; end < statements.length; end++) {
            const current = statements[end]!;
            for (const token of current.tokens) tokens.push(token);
            const coversBlock = start === 0 && end === statements.length - 1;
            const candidateTokens = coversBlock ? fullBlockTokens : tokens;
            if (candidateTokens.length < minTokens) continue;
            const rangeStart = coversBlock
              ? node.getStart(source)
              : first.statement.getStart(source);
            const rangeEnd = coversBlock
              ? node.getEnd()
              : current.statement.getEnd();
            const lineCount = coversBlock
              ? blockLineCount
              : current.endLine - first.startLine + 1;
            if (lineCount < minLines) continue;
            blocks.push({
              file,
              blockStart,
              line: (coversBlock ? blockStartLine : first.startLine) + 1,
              start: rangeStart,
              end: rangeEnd,
              tokenCount: candidateTokens.length,
              lineCount,
              signature: JSON.stringify(candidateTokens),
              statements,
              firstStatement: start,
              lastStatement: end,
            });
            wholeBlockAdded = coversBlock;
            break;
          }
          if (
            start === 0 &&
            !wholeBlockAdded &&
            fullBlockTokens.length >= minTokens &&
            blockLineCount >= minLines
          )
            blocks.push({
              file,
              blockStart,
              line: blockStartLine + 1,
              start: node.getStart(source),
              end: node.getEnd(),
              tokenCount: fullBlockTokens.length,
              lineCount: blockLineCount,
              signature: JSON.stringify(fullBlockTokens),
              statements,
              firstStatement: 0,
              lastStatement: statements.length - 1,
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { blocks, repeatedRuns };
}

const codeClone: ProjectRule = {
  kind: "project",
  id: "code-clone",
  aliases: ["code_clone"],
  description:
    "Exact consecutive AST statements repeated across source locations should share one implementation.",
  defaultLevel: "off",
  check(ctx) {
    const minTokens = positiveInteger(
      option(ctx, "minTokens", 50),
      "minTokens"
    );
    const minLines = positiveInteger(option(ctx, "minLines", 6), "minLines");
    const collected = collectBlocks(ctx, minTokens, minLines);
    const groups = new Map<string, CloneBlock[]>();
    for (const block of collected.blocks) {
      const group = groups.get(block.signature);
      if (group) group.push(block);
      else groups.set(block.signature, [block]);
    }

    const confirmedPairs: CloneBlock[] = [];
    for (const candidates of [...groups.values()])
      for (const candidate of expandOccurrences(
        candidates,
        minTokens,
        minLines
      )) {
        confirmedPairs.push(candidate);
        const group = groups.get(candidate.signature);
        if (group) group.push(candidate);
        else groups.set(candidate.signature, [candidate]);
      }

    const findings: Violation[] = [];
    const covered = new Map<string, { start: number; end: number }[]>();
    const unmatchedRepeatedRuns = collected.repeatedRuns.filter(
      (run) =>
        !confirmedPairs.some(
          (candidate) =>
            candidate.file === run.file &&
            candidate.start <= run.coverageStart &&
            candidate.end >= run.end
        )
    );
    for (const run of unmatchedRepeatedRuns) {
      const ranges = covered.get(run.file);
      const range = { start: run.coverageStart, end: run.end };
      if (ranges) ranges.push(range);
      else covered.set(run.file, [range]);
    }
    const ordered = [...groups.entries()].sort((left, right) => {
      const a = left[1][0]!;
      const b = right[1][0]!;
      return (
        b.tokenCount - a.tokenCount ||
        b.lineCount - a.lineCount ||
        a.file.localeCompare(b.file) ||
        a.start - b.start ||
        left[0].localeCompare(right[0])
      );
    });
    for (const [signature, candidates] of ordered) {
      const allCandidates = nonoverlappingOccurrences(candidates);
      const uncovered = allCandidates.filter(
        (candidate) =>
          !fullyCovered(candidate, covered.get(candidate.file) ?? [])
      );
      if (allCandidates.length < 2 || uncovered.length === 0) continue;
      for (const clone of uncovered) {
        const ranges = covered.get(clone.file);
        const range = { start: clone.start, end: clone.end };
        if (ranges) ranges.push(range);
        else covered.set(clone.file, [range]);
      }
      allCandidates.sort(
        (left, right) =>
          left.file.localeCompare(right.file) || left.line - right.line
      );
      const original = allCandidates[0]!;
      const fingerprint = createHash("sha256").update(signature).digest("hex");
      const occurrences = new Map<string, number>();
      for (const clone of uncovered) {
        if (clone.file === original.file && clone.start === original.start)
          continue;
        const occurrence = occurrences.get(clone.file) ?? 0;
        occurrences.set(clone.file, occurrence + 1);
        findings.push({
          file: clone.file,
          line: clone.line,
          rule: "code-clone",
          identity: `clone:${fingerprint}:${clone.file}:${occurrence}`,
          message: `Duplicated statement run matches ${original.file}:${original.line} (${clone.tokenCount} tokens across ${clone.lineCount} lines)`,
        });
      }
    }
    for (const run of unmatchedRepeatedRuns) {
      const fingerprint = createHash("sha256")
        .update(run.signature)
        .digest("hex");
      findings.push({
        file: run.file,
        line: run.line,
        rule: "code-clone",
        identity: `clone-run:${fingerprint}:${run.file}:${run.start}`,
        message: `Repeated statement occurs ${run.repetitions} times in a row (${run.tokenCount} tokens across ${run.lineCount} lines)`,
      });
    }
    return findings;
  },
};

export const RULES = [codeClone];
