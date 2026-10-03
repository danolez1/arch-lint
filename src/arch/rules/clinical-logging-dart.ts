import type { Violation } from "../types";
import { violation } from "./util";

type DartToken = { line: number; value: string };
const DART_STRING_TOKEN = "\u0000string:";

function dartQuotedLiteralEnd(source: string, start: number): number {
  const raw =
    (source[start] === "r" || source[start] === "R") &&
    (source[start + 1] === "'" || source[start + 1] === '"');
  const quoteIndex = raw ? start + 1 : start;
  const quote = source[quoteIndex] ?? "";
  const triple = source.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3);
  let index = quoteIndex + (triple ? 3 : 1);
  while (index < source.length) {
    if (!raw && source[index] === "\\") {
      index += 2;
      continue;
    }
    if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
      return index + 3;
    }
    if (!triple && source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function dartInterpolationEnd(
  source: string,
  start: number
): number | undefined {
  let depth = 1;
  let index = start;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      let commentDepth = 1;
      while (index < source.length && commentDepth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          commentDepth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          commentDepth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    const rawPrefix =
      (char === "r" || char === "R") && (next === "'" || next === '"');
    if (char === "'" || char === '"' || rawPrefix) {
      index = dartQuotedLiteralEnd(source, index);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return undefined;
}

function dartTokens(source: string): DartToken[] {
  const tokens: DartToken[] = [];
  let index = 0;
  let line = 1;
  while (index < source.length) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (char === "\n") {
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < source.length && depth > 0) {
        if (source[index] === "\n") line += 1;
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    const rawPrefix =
      (char === "r" || char === "R") && (next === "'" || next === '"');
    if (char === "'" || char === '"' || rawPrefix) {
      const raw = rawPrefix;
      const quoteIndex = raw ? index + 1 : index;
      const quote = source[quoteIndex] ?? "";
      const triple =
        source.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3);
      const literalEnd = dartQuotedLiteralEnd(source, index);
      const delimiterLength = triple ? 3 : 1;
      tokens.push({
        line,
        value: `${DART_STRING_TOKEN}${source.slice(
          quoteIndex + delimiterLength,
          Math.max(quoteIndex + delimiterLength, literalEnd - delimiterLength)
        )}`,
      });
      index = quoteIndex + (triple ? 3 : 1);
      while (index < source.length) {
        if (!raw && source[index] === "\\") {
          index += 2;
          continue;
        }
        if (!raw && source[index] === "$" && source[index + 1] === "{") {
          const interpolationStart = index + 2;
          const interpolationEnd = dartInterpolationEnd(
            source,
            interpolationStart
          );
          const expressionEnd = interpolationEnd ?? source.length;
          for (const token of dartTokens(
            source.slice(interpolationStart, expressionEnd)
          )) {
            tokens.push({ ...token, line: token.line + line - 1 });
          }
          const consumedEnd =
            interpolationEnd === undefined
              ? source.length
              : interpolationEnd + 1;
          line += source.slice(index, consumedEnd).split("\n").length - 1;
          index = consumedEnd;
          continue;
        }
        if (source[index] === "\n") line += 1;
        if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
          index += 3;
          break;
        }
        if (!triple && source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (/[A-Za-z_$]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_$]/.test(source[index] ?? ""))
        index += 1;
      tokens.push({ line, value: source.slice(start, index) });
      continue;
    }
    tokens.push({ line, value: char });
    index += 1;
  }
  return tokens;
}

function dartStatementEnd(tokens: readonly DartToken[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const value = tokens[index]?.value;
    if (value === "(" || value === "[" || value === "{") depth += 1;
    if (value === ")" || value === "]" || value === "}")
      depth = Math.max(0, depth - 1);
    if (value === ";" && depth === 0) return index;
  }
  return tokens.length;
}

function dartCallStart(
  tokens: readonly DartToken[],
  start: number
): number | undefined {
  let index = start + 1;
  while (index < tokens.length) {
    if (tokens[index]?.value === "!" || tokens[index]?.value === ")") {
      index += 1;
      continue;
    }
    if (tokens[index]?.value === "as") {
      index += 1;
      let depth = 0;
      while (index < tokens.length) {
        if (tokens[index]?.value === "(") depth += 1;
        if (tokens[index]?.value === ")") {
          if (depth === 0) {
            index += 1;
            break;
          }
          depth -= 1;
        }
        index += 1;
      }
      continue;
    }
    if (tokens[index]?.value === "?") {
      if (tokens[index + 1]?.value !== ".") return undefined;
      index += 1;
    }
    if (tokens[index]?.value !== "." || tokens[index + 1]?.value !== "call")
      break;
    index += 2;
  }
  return tokens[index]?.value === "(" ? index : undefined;
}

function dartContainerCallStart(
  tokens: readonly DartToken[],
  start: number
): number | undefined {
  let index = start + 1;
  while (index < tokens.length) {
    if (tokens[index]?.value === "[") {
      let depth = 1;
      index += 1;
      while (index < tokens.length && depth > 0) {
        if (tokens[index]?.value === "[") depth += 1;
        if (tokens[index]?.value === "]") depth -= 1;
        index += 1;
      }
      continue;
    }
    if (tokens[index]?.value === "!" || tokens[index]?.value === ")") {
      index += 1;
      continue;
    }
    if (tokens[index]?.value === "?") {
      if (tokens[index + 1]?.value !== ".") return undefined;
      index += 1;
    }
    if (tokens[index]?.value !== "." || !tokens[index + 1]) break;
    index += 2;
  }
  return tokens[index]?.value === "(" ? index : undefined;
}

function dartEnclosingDelimiter(
  tokens: readonly DartToken[],
  start: number
): string | undefined {
  const closing = new Map<string, string>([
    [")", "("],
    ["]", "["],
    ["}", "{"],
  ]);
  const pending: string[] = [];
  for (let index = start - 1; index >= 0; index -= 1) {
    const value = tokens[index]?.value;
    if (!value) continue;
    const opener = closing.get(value);
    if (opener) {
      pending.push(opener);
      continue;
    }
    if (value !== "(" && value !== "[" && value !== "{") continue;
    if (pending.at(-1) === value) {
      pending.pop();
      continue;
    }
    if (pending.length === 0) return value;
  }
  return undefined;
}

function dartPassedAsCallback(
  tokens: readonly DartToken[],
  start: number,
  end: number
): boolean {
  const previous = tokens[start - 1]?.value;
  const next = tokens[end + 1]?.value;
  const startsArgument =
    previous === "(" ||
    previous === "," ||
    previous === "[" ||
    (previous === ":" && dartEnclosingDelimiter(tokens, start) === "(");
  return (
    startsArgument &&
    (next === ")" || next === "," || next === "]" || next === "}")
  );
}

type DartOutputImports = {
  async: Set<string>;
  core: Set<string>;
  developer: Set<string>;
  foundation: Set<string>;
  io: Set<string>;
  unprefixedAsync: boolean;
  unprefixedDeveloper: boolean;
  unprefixedFoundation: boolean;
  unprefixedIo: boolean;
};

function dartOutputImports(tokens: readonly DartToken[]): DartOutputImports {
  const imports: DartOutputImports = {
    async: new Set(),
    core: new Set(),
    developer: new Set(),
    foundation: new Set(),
    io: new Set(),
    unprefixedAsync: false,
    unprefixedDeveloper: false,
    unprefixedFoundation: false,
    unprefixedIo: false,
  };
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "import") continue;
    const uriToken = tokens[index + 1]?.value;
    if (!uriToken?.startsWith(DART_STRING_TOKEN)) continue;
    const uri = uriToken.slice(DART_STRING_TOKEN.length);
    let cursor = index + 2;
    let prefix: string | undefined;
    while (cursor < tokens.length && tokens[cursor]?.value !== ";") {
      if (tokens[cursor]?.value === "as") prefix = tokens[cursor + 1]?.value;
      cursor += 1;
    }
    const target =
      uri === "dart:async"
        ? imports.async
        : uri === "dart:core"
          ? imports.core
          : uri === "dart:developer"
            ? imports.developer
            : uri === "dart:io"
              ? imports.io
              : /^package:flutter\/(?:cupertino|foundation|material|widgets)\.dart$/.test(
                    uri
                  )
                ? imports.foundation
                : undefined;
    if (target && prefix) target.add(prefix);
    if (uri === "dart:async" && !prefix) imports.unprefixedAsync = true;
    if (uri === "dart:developer" && !prefix) imports.unprefixedDeveloper = true;
    if (
      /^package:flutter\/(?:cupertino|foundation|material|widgets)\.dart$/.test(
        uri
      ) &&
      !prefix
    ) {
      imports.unprefixedFoundation = true;
    }
    if (uri === "dart:io" && !prefix) imports.unprefixedIo = true;
    index = cursor;
  }
  return imports;
}

const DART_FOUNDATION_SINKS = new Set([
  "debugPrint",
  "debugPrintStack",
  "debugPrintSynchronously",
  "debugPrintThrottled",
]);
const DART_IO_SINK_METHODS = new Set([
  "add",
  "addStream",
  "write",
  "writeAll",
  "writeCharCode",
  "writeln",
]);

function dartKnownSinkEnd(
  tokens: readonly DartToken[],
  index: number,
  imports: DartOutputImports
): number | undefined {
  const owner = tokens[index]?.value;
  const member = tokens[index + 2]?.value;
  if (tokens[index + 1]?.value === ".") {
    if (owner && dartParameterShadowsName(tokens, index, owner))
      return undefined;
    if (imports.developer.has(owner ?? "") && member === "log")
      return index + 2;
    if (
      imports.foundation.has(owner ?? "") &&
      member &&
      DART_FOUNDATION_SINKS.has(member)
    ) {
      return index + 2;
    }
    if (imports.core.has(owner ?? "") && member === "print") return index + 2;
    if (
      imports.io.has(owner ?? "") &&
      (member === "stdout" || member === "stderr") &&
      tokens[index + 3]?.value === "." &&
      DART_IO_SINK_METHODS.has(tokens[index + 4]?.value ?? "")
    ) {
      return index + 4;
    }
    if (
      imports.unprefixedFoundation &&
      owner === "FlutterError" &&
      !dartHasDeclaration(tokens, "FlutterError") &&
      (member === "dumpErrorToConsole" || member === "presentError")
    ) {
      return index + 2;
    }
    if (
      imports.unprefixedIo &&
      (owner === "stdout" || owner === "stderr") &&
      member &&
      DART_IO_SINK_METHODS.has(member)
    ) {
      return index + 2;
    }
  }
  return imports.unprefixedAsync && dartIsZonePrintAt(tokens, index)
    ? index + 4
    : undefined;
}

function dartIsFunctionDeclaration(
  tokens: readonly DartToken[],
  nameIndex: number
): boolean {
  const callStart = dartCallStart(tokens, nameIndex);
  if (callStart === undefined) return false;
  let depth = 1;
  let cursor = callStart + 1;
  while (cursor < tokens.length && depth > 0) {
    if (tokens[cursor]?.value === "(") depth += 1;
    if (tokens[cursor]?.value === ")") depth -= 1;
    cursor += 1;
  }
  return (
    depth === 0 &&
    (tokens[cursor]?.value === "{" ||
      (tokens[cursor]?.value === "=" && tokens[cursor + 1]?.value === ">"))
  );
}

function dartHasDeclaration(
  tokens: readonly DartToken[],
  name: string
): boolean {
  let braceDepth = 0;
  return tokens.some((token, index) => {
    if (token.value === "}") braceDepth = Math.max(0, braceDepth - 1);
    const atTopLevel = braceDepth === 0;
    if (token.value === "{") braceDepth += 1;
    if (token.value !== name) return false;
    const previous = tokens[index - 1]?.value;
    return (
      (atTopLevel && previous === "class") ||
      (atTopLevel && previous === "enum") ||
      (atTopLevel && previous === "mixin") ||
      (atTopLevel && previous === "extension") ||
      (atTopLevel && dartIsFunctionDeclaration(tokens, index))
    );
  });
}

function dartMatchingOpen(
  tokens: readonly DartToken[],
  closeIndex: number,
  open: string,
  close: string
): number | undefined {
  let depth = 1;
  for (let index = closeIndex - 1; index >= 0; index -= 1) {
    if (tokens[index]?.value === close) depth += 1;
    if (tokens[index]?.value !== open) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function dartMatchingClose(
  tokens: readonly DartToken[],
  openIndex: number,
  open: string,
  close: string
): number | undefined {
  let depth = 1;
  for (let index = openIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index]?.value === open) depth += 1;
    if (tokens[index]?.value !== close) continue;
    depth -= 1;
    if (depth === 0) return index;
  }
  return undefined;
}

function dartParameterShadowsName(
  tokens: readonly DartToken[],
  useIndex: number,
  name: string
): boolean {
  for (let bodyStart = 0; bodyStart < useIndex; bodyStart += 1) {
    if (tokens[bodyStart]?.value !== "{") continue;
    const bodyEnd = dartMatchingClose(tokens, bodyStart, "{", "}");
    if (bodyEnd === undefined || bodyEnd < useIndex) continue;
    const parametersEnd = bodyStart - 1;
    if (tokens[parametersEnd]?.value !== ")") continue;
    const parametersStart = dartMatchingOpen(tokens, parametersEnd, "(", ")");
    if (parametersStart === undefined) continue;
    for (let index = parametersStart + 1; index < parametersEnd; index += 1) {
      if (tokens[index]?.value === name) return true;
    }
  }
  return false;
}

function dartShadowsRawFunction(
  tokens: readonly DartToken[],
  index: number,
  name: string
): boolean {
  return (
    dartHasDeclaration(tokens, name) ||
    dartParameterShadowsName(tokens, index, name)
  );
}

function dartRangeCarriesRawSink(
  tokens: readonly DartToken[],
  start: number,
  end: number,
  rawFunctions: ReadonlySet<string>,
  rawContainers: ReadonlySet<string>,
  imports: DartOutputImports
): boolean {
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (rawContainers.has(token.value)) return true;
    if (
      rawFunctions.has(token.value) &&
      tokens[index - 1]?.value !== "." &&
      !dartShadowsRawFunction(tokens, index, token.value)
    ) {
      return true;
    }
    if (dartKnownSinkEnd(tokens, index, imports) !== undefined) return true;
  }
  return false;
}

function dartIsZonePrintAt(
  tokens: readonly DartToken[],
  index: number
): boolean {
  return (
    tokens[index]?.value === "Zone" &&
    tokens[index + 1]?.value === "." &&
    tokens[index + 2]?.value === "current" &&
    tokens[index + 3]?.value === "." &&
    tokens[index + 4]?.value === "print"
  );
}

export function analyzeDartSource(
  file: string,
  source: string,
  scope: { mobileUpload: boolean }
): Violation[] {
  const tokens = dartTokens(source);
  const imports = dartOutputImports(tokens);
  const violations: Violation[] = [];
  if (
    scope.mobileUpload &&
    (tokens.some((token) =>
      [
        "FormData",
        "MultipartFile",
        "MultipartRequest",
        "MultiUploadTask",
      ].includes(token.value)
    ) ||
      (tokens.some((token) => token.value === "UploadTask") &&
        tokens.some((token) => token.value === "fields")))
  ) {
    violations.push(
      violation(
        file,
        1,
        "no-mobile-image-body-upload",
        "Mobile image bytes must use signed object-storage requests"
      )
    );
  }
  const rawFunctions = new Set(["print"]);
  if (imports.unprefixedDeveloper) rawFunctions.add("log");
  if (imports.unprefixedFoundation) {
    for (const sink of DART_FOUNDATION_SINKS) rawFunctions.add(sink);
  }
  const rawMemberFunctions = new Set<string>();
  const rawContainers = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const assigned = tokens[index];
      if (
        assigned &&
        tokens[index + 1]?.value === "." &&
        tokens[index + 2] &&
        tokens[index + 3]?.value === "="
      ) {
        const expressionStart = index + 4;
        const expressionEnd = dartStatementEnd(tokens, expressionStart);
        if (
          dartRangeCarriesRawSink(
            tokens,
            expressionStart,
            expressionEnd,
            rawFunctions,
            rawContainers,
            imports
          )
        ) {
          if (!rawContainers.has(assigned.value)) {
            rawContainers.add(assigned.value);
            changed = true;
          }
          const member = tokens[index + 2];
          if (member && !rawFunctions.has(member.value)) {
            rawFunctions.add(member.value);
            rawMemberFunctions.add(member.value);
            changed = true;
          }
        }
      }
      if (!assigned || tokens[index + 1]?.value !== "=") continue;
      const expressionStart = index + 2;
      const expressionEnd = dartStatementEnd(tokens, expressionStart);
      if (
        !dartRangeCarriesRawSink(
          tokens,
          expressionStart,
          expressionEnd,
          rawFunctions,
          rawContainers,
          imports
        )
      ) {
        continue;
      }
      const containerLiteral =
        tokens[expressionStart]?.value === "{" ||
        tokens[expressionStart]?.value === "[";
      const targets = containerLiteral ? rawContainers : rawFunctions;
      if (!targets.has(assigned.value)) {
        targets.add(assigned.value);
        if (!containerLiteral) rawMemberFunctions.add(assigned.value);
        changed = true;
      }
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const previous = tokens[index - 1]?.value;
    const next = tokens[index + 1]?.value;
    const passedAsCallback = dartPassedAsCallback(tokens, index, index);
    const shadowsSink = dartShadowsRawFunction(tokens, index, token.value);
    const returnedSink =
      previous === "return" && rawFunctions.has(token.value) && !shadowsSink;
    const directSink =
      rawFunctions.has(token.value) &&
      !shadowsSink &&
      previous !== "." &&
      !dartIsFunctionDeclaration(tokens, index) &&
      (dartCallStart(tokens, index) !== undefined || passedAsCallback);
    const memberName = tokens[index + 2]?.value;
    const memberLog =
      next === "." && Boolean(memberName && rawMemberFunctions.has(memberName));
    const memberSink =
      memberLog &&
      (dartCallStart(tokens, index + 2) !== undefined ||
        dartPassedAsCallback(tokens, index, index + 2) ||
        previous === "return");
    const knownSinkEnd = dartKnownSinkEnd(tokens, index, imports);
    const knownSink =
      knownSinkEnd !== undefined &&
      !dartIsFunctionDeclaration(tokens, knownSinkEnd) &&
      (dartCallStart(tokens, knownSinkEnd) !== undefined ||
        dartPassedAsCallback(tokens, index, knownSinkEnd) ||
        previous === "return");
    const containerSink =
      rawContainers.has(token.value) &&
      dartContainerCallStart(tokens, index) !== undefined;
    if (
      directSink ||
      memberSink ||
      knownSink ||
      containerSink ||
      returnedSink
    ) {
      violations.push(
        violation(
          file,
          token.line,
          "phi-safe-mobile-logger-required",
          "Mobile production code must not use print, debugPrint, or developer log sinks"
        )
      );
    }
  }
  return violations;
}
