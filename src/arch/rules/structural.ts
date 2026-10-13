import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { matchesAny, matchesPattern } from "../paths";
import type { ProjectContext, ProjectRule, Violation } from "../types";
import { messageFor, option, positiveInteger } from "./util";

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

interface ParsedFile {
  path: string;
  root: ts.SourceFile;
  lines: string[];
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:m|c)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  )
    current = current.expression;
  return current;
}

function sourceLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (text.endsWith("\n") || text.endsWith("\r")) lines.pop();
  return lines.length ? lines : [""];
}

function projectSources(ctx: ProjectContext): ParsedFile[] {
  return ctx
    .listFiles(SOURCE_EXTENSIONS)
    .filter(
      (file) =>
        !/\.d\.(?:ts|mts|cts)$/.test(file) &&
        !matchesAny(file, ctx.config.tests)
    )
    .flatMap((file) => {
      const text = ctx.read(file);
      if (text === null) return [];
      return [
        {
          path: file,
          root: ts.createSourceFile(
            file,
            text,
            ts.ScriptTarget.Latest,
            true,
            scriptKind(file)
          ),
          lines: sourceLines(text),
        },
      ];
    });
}

function source(file: ParsedFile) {
  return file.root;
}

function functionName(node: ts.Node): string {
  const named = "name" in node ? (node.name as ts.Node | undefined) : undefined;
  if (named && (ts.isIdentifier(named) || ts.isStringLiteralLike(named)))
    return named.text;
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent) || ts.isVariableDeclaration(parent))
    return ts.isIdentifier(parent.name) ? parent.name.text : "function";
  return "function";
}

function anonymousFunctionContext(file: ParsedFile, node: ts.Node): string {
  let expression = node;
  while (expression.parent && ts.isParenthesizedExpression(expression.parent))
    expression = expression.parent;
  if (ts.isExpression(expression))
    expression = unwrapTransparentExpression(expression);
  const parent = expression.parent;
  if (parent && ts.isCallExpression(parent))
    return JSON.stringify([
      "call",
      parent.expression.getText(file.root),
      parent.arguments.indexOf(expression as ts.Expression),
    ]);
  if (parent && ts.isNewExpression(parent))
    return JSON.stringify([
      "new",
      parent.expression.getText(file.root),
      parent.arguments?.indexOf(expression as ts.Expression) ?? -1,
    ]);
  if (parent && ts.isVariableDeclaration(parent))
    return JSON.stringify(["variable", parent.name.getText(file.root)]);
  if (parent && ts.isPropertyAssignment(parent))
    return JSON.stringify(["property", parent.name.getText(file.root)]);
  if (parent && ts.isArrayLiteralExpression(parent)) return '["array"]';
  return JSON.stringify([parent ? ts.SyntaxKind[parent.kind] : "root"]);
}

function structuralScopes(
  file: ParsedFile,
  node: ts.Node,
  includeBlockScopes = false
): string[] {
  const scopes: string[] = [];
  let ancestor = node.parent;
  while (ancestor && ancestor !== file.root) {
    if (ts.isClassLike(ancestor) && ancestor.name) {
      scopes.unshift(`class:${ancestor.name.text}`);
    } else if (ts.isModuleDeclaration(ancestor)) {
      scopes.unshift(`module:${ancestor.name.getText(file.root)}`);
    } else if (ts.isFunctionLike(ancestor)) {
      const name = functionName(ancestor);
      if (name !== "function") {
        scopes.unshift(`function:${name}`);
      } else
        scopes.unshift(`anonymous:${anonymousFunctionContext(file, ancestor)}`);
    } else if (includeBlockScopes && ts.isBlock(ancestor)) {
      const parent = ancestor.parent;
      if (ts.isIfStatement(parent)) {
        const branch = parent.thenStatement === ancestor ? "then" : "else";
        scopes.unshift(`if:${branch}`);
      } else if (ts.isIterationStatement(parent, false)) {
        scopes.unshift(`loop:${ts.SyntaxKind[parent.kind]}`);
      } else if (ts.isTryStatement(parent)) {
        const branch =
          parent.tryBlock === ancestor
            ? "try"
            : parent.catchClause?.block === ancestor
              ? "catch"
              : "finally";
        scopes.unshift(`try:${branch}`);
      } else if (ts.isCatchClause(parent)) {
        scopes.unshift("catch");
      } else if (ts.isBlock(parent)) {
        scopes.unshift("block");
      }
    }
    ancestor = ancestor.parent;
  }
  return scopes;
}

function structuralIdentity(file: ParsedFile, node: ts.Node): string {
  const scopes = structuralScopes(file, node);
  const name = functionName(node);
  if (name !== "function")
    return `${file.path}:${[...scopes, `${ts.SyntaxKind[node.kind]}:${name}`].join("/")}`;
  const context = anonymousFunctionContext(file, node);
  return `${file.path}:${[...scopes, `anonymous:${context}`].join("/")}`;
}

function isNestedFunction(node: ts.Node): boolean {
  return ts.isFunctionLike(node);
}

function hasBody(
  node: ts.SignatureDeclaration
): node is ts.SignatureDeclaration & { body: ts.ConciseBody } {
  return "body" in node && node.body !== undefined;
}

function decisionPoints(node: ts.Node): number {
  let count = 0;
  const visit = (child: ts.Node) => {
    if (child !== node && isNestedFunction(child)) return;
    if (
      ts.isIfStatement(child) ||
      ts.isForStatement(child) ||
      ts.isForInStatement(child) ||
      ts.isForOfStatement(child) ||
      ts.isWhileStatement(child) ||
      ts.isDoStatement(child) ||
      ts.isCatchClause(child) ||
      ts.isConditionalExpression(child) ||
      (ts.isCaseClause(child) && child.expression !== undefined) ||
      (ts.isBinaryExpression(child) &&
        (child.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          child.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          child.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) ||
      (ts.isBinaryExpression(child) &&
        (child.operatorToken.kind ===
          ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
          child.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken ||
          child.operatorToken.kind ===
            ts.SyntaxKind.QuestionQuestionEqualsToken))
    )
      count++;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return count;
}

const COGNITIVE_CONTROL_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.SwitchStatement,
]);
const COGNITIVE_LOGICAL_KINDS = new Set([
  ts.SyntaxKind.AmpersandAmpersandToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
]);

function cognitiveComplexity(node: ts.Node): number {
  let score = 0;
  const visit = (
    child: ts.Node,
    nesting: number,
    parent: ts.Node | undefined
  ) => {
    if (child !== node && isNestedFunction(child)) return;
    const elseIf =
      ts.isIfStatement(child) &&
      parent !== undefined &&
      ts.isIfStatement(parent) &&
      parent.elseStatement === child;
    if (COGNITIVE_CONTROL_KINDS.has(child.kind))
      score += 1 + (elseIf ? 0 : nesting);
    if (
      ts.isIfStatement(child) &&
      child.elseStatement &&
      !ts.isIfStatement(child.elseStatement)
    )
      score++;
    if (
      ts.isBinaryExpression(child) &&
      COGNITIVE_LOGICAL_KINDS.has(child.operatorToken.kind) &&
      !(
        child.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
        (child.right.kind === ts.SyntaxKind.TrueKeyword ||
          child.right.kind === ts.SyntaxKind.FalseKeyword ||
          child.right.kind === ts.SyntaxKind.NullKeyword ||
          (ts.isIdentifier(child.right) && child.right.text === "undefined"))
      ) &&
      !(
        parent &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === child.operatorToken.kind
      )
    )
      score++;
    if (
      (ts.isBreakStatement(child) || ts.isContinueStatement(child)) &&
      child.label
    )
      score++;
    const nextNesting = COGNITIVE_CONTROL_KINDS.has(child.kind)
      ? nesting + (elseIf ? 0 : 1)
      : nesting;
    ts.forEachChild(child, (nested) => visit(nested, nextNesting, child));
  };
  visit(node, 0, undefined);
  return score;
}

function functionCount(root: ts.SourceFile): number {
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) {
      if (hasBody(node)) count++;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return count;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  );
}

function isMutableStateInitializer(
  initializer: ts.Expression | undefined
): boolean {
  return (
    initializer !== undefined &&
    (ts.isObjectLiteralExpression(initializer) ||
      ts.isArrayLiteralExpression(initializer) ||
      ts.isNewExpression(initializer))
  );
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
  );
}

function mutableBindingNames(
  name: ts.BindingName,
  initializer: ts.Expression | undefined,
  forceMutable: boolean
): string[] {
  if (ts.isIdentifier(name))
    return forceMutable || isMutableStateInitializer(initializer)
      ? [name.text]
      : [];
  if (forceMutable || isMutableStateInitializer(initializer))
    return bindingNames(name);

  if (
    ts.isObjectBindingPattern(name) &&
    initializer &&
    ts.isObjectLiteralExpression(initializer)
  ) {
    return name.elements.flatMap((element) => {
      const key = element.propertyName ?? element.name;
      if (!ts.isIdentifier(key) && !ts.isStringLiteralLike(key)) return [];
      const property = initializer.properties.find(
        (candidate) =>
          !ts.isSpreadAssignment(candidate) &&
          "name" in candidate &&
          candidate.name &&
          (ts.isIdentifier(candidate.name) ||
            ts.isStringLiteralLike(candidate.name)) &&
          candidate.name.text === key.text
      );
      const value =
        property && ts.isPropertyAssignment(property)
          ? property.initializer
          : undefined;
      return value ? mutableBindingNames(element.name, value, false) : [];
    });
  }

  if (
    ts.isArrayBindingPattern(name) &&
    initializer &&
    ts.isArrayLiteralExpression(initializer)
  ) {
    return name.elements.flatMap((element, index) => {
      if (ts.isOmittedExpression(element)) return [];
      const value = initializer.elements[index];
      return value
        ? mutableBindingNames(
            element.name,
            ts.isSpreadElement(value) ? value.expression : value,
            false
          )
        : [];
    });
  }

  return [];
}

function functionsIn(root: ts.SourceFile): ts.SignatureDeclaration[] {
  const found: ts.SignatureDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function functionViolation(
  file: ParsedFile,
  root: ts.SourceFile,
  node: ts.SignatureDeclaration,
  rule: string,
  message: string,
  metrics?: Violation["metrics"]
): Violation {
  const line = root.getLineAndCharacterOfPosition(node.getStart(root)).line + 1;
  return {
    file: file.path,
    line,
    rule,
    identity: structuralIdentity(file, node),
    message,
    ...(metrics ? { metrics } : {}),
  };
}

const cyclomaticComplexity: ProjectRule = {
  kind: "project",
  id: "cyclomatic-complexity",
  description:
    "Functions must stay under the configured number of independent branches.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(option(ctx, "max", 10), "max");
    return projectSources(ctx).flatMap((file) =>
      functionsIn(source(file)).flatMap((node) => {
        if (!hasBody(node)) return [];
        const score = 1 + decisionPoints(node.body);
        if (score <= maximum) return [];
        return [
          functionViolation(
            file,
            file.root,
            node,
            "cyclomatic-complexity",
            messageFor(
              ctx,
              `${functionName(node)} has cyclomatic complexity ${score}, above the limit of ${maximum}`
            ),
            { complexity: { value: score, worsening: "higher" } }
          ),
        ];
      })
    );
  },
};

const cognitiveComplexityRule: ProjectRule = {
  kind: "project",
  id: "cognitive-complexity",
  description:
    "Functions must stay under the configured nesting-weighted control-flow score.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(option(ctx, "max", 15), "max");
    return projectSources(ctx).flatMap((file) =>
      functionsIn(source(file)).flatMap((node) => {
        if (!hasBody(node)) return [];
        const score = cognitiveComplexity(node.body);
        if (score <= maximum) return [];
        return [
          functionViolation(
            file,
            file.root,
            node,
            "cognitive-complexity",
            messageFor(
              ctx,
              `${functionName(node)} has cognitive complexity ${score}, above the limit of ${maximum}`
            ),
            { complexity: { value: score, worsening: "higher" } }
          ),
        ];
      })
    );
  },
};

const longParameterList: ProjectRule = {
  kind: "project",
  id: "long-parameter-list",
  description:
    "Functions must not take more than the configured parameter count.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(option(ctx, "max", 5), "max");
    return projectSources(ctx).flatMap((file) =>
      functionsIn(source(file)).flatMap((node) => {
        if (node.parameters.length <= maximum) return [];
        return [
          functionViolation(
            file,
            file.root,
            node,
            "long-parameter-list",
            messageFor(
              ctx,
              `${functionName(node)} has ${node.parameters.length} parameters, above the limit of ${maximum}`
            ),
            {
              parameters: {
                value: node.parameters.length,
                worsening: "higher",
              },
            }
          ),
        ];
      })
    );
  },
};

function maxNesting(node: ts.SignatureDeclaration): number {
  if (!hasBody(node)) return 0;
  const nestedKinds = new Set([
    ts.SyntaxKind.IfStatement,
    ts.SyntaxKind.ForStatement,
    ts.SyntaxKind.ForInStatement,
    ts.SyntaxKind.ForOfStatement,
    ts.SyntaxKind.WhileStatement,
    ts.SyntaxKind.DoStatement,
    ts.SyntaxKind.SwitchStatement,
    ts.SyntaxKind.TryStatement,
    ts.SyntaxKind.CatchClause,
  ]);
  let maximum = 0;
  const visit = (child: ts.Node, depth: number) => {
    if (child !== node && isNestedFunction(child)) return;
    const next = depth + (nestedKinds.has(child.kind) ? 1 : 0);
    maximum = Math.max(maximum, next);
    ts.forEachChild(child, (nested) => visit(nested, next));
  };
  visit(node.body, 0);
  return maximum;
}

const deepNesting: ProjectRule = {
  kind: "project",
  id: "deep-nesting",
  description: "Control flow must stay below the configured nesting depth.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(option(ctx, "max", 4), "max");
    return projectSources(ctx).flatMap((file) =>
      functionsIn(source(file)).flatMap((node) => {
        const depth = maxNesting(node);
        if (depth <= maximum) return [];
        return [
          functionViolation(
            file,
            file.root,
            node,
            "deep-nesting",
            messageFor(
              ctx,
              `${functionName(node)} nests control flow ${depth} levels, above the limit of ${maximum}`
            ),
            { depth: { value: depth, worsening: "higher" } }
          ),
        ];
      })
    );
  },
};

const largeFunction: ProjectRule = {
  kind: "project",
  id: "large-function",
  description: "Functions must stay under the configured source-line limit.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(option(ctx, "maxLines", 50), "maxLines");
    return projectSources(ctx).flatMap((file) =>
      functionsIn(source(file)).flatMap((node) => {
        if (!hasBody(node)) return [];
        const start = file.root.getLineAndCharacterOfPosition(
          node.getStart(file.root)
        ).line;
        const end = file.root.getLineAndCharacterOfPosition(node.end).line;
        const lines = end - start + 1;
        if (lines <= maximum) return [];
        return [
          functionViolation(
            file,
            file.root,
            node,
            "large-function",
            messageFor(
              ctx,
              `${functionName(node)} spans ${lines} lines, above the limit of ${maximum}`
            ),
            { lines: { value: lines, worsening: "higher" } }
          ),
        ];
      })
    );
  },
};

const largeFile: ProjectRule = {
  kind: "project",
  id: "large-file",
  description: "Source files must stay under the configured line limit.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(option(ctx, "maxLines", 500), "maxLines");
    return projectSources(ctx).flatMap((file) =>
      file.lines.length <= maximum
        ? []
        : [
            {
              file: file.path,
              line: maximum + 1,
              rule: "large-file",
              identity: `large-file:${file.path}`,
              metrics: {
                lines: { value: file.lines.length, worsening: "higher" },
              },
              message: messageFor(
                ctx,
                `${file.path} has ${file.lines.length} lines, above the limit of ${maximum}`
              ),
            },
          ]
    );
  },
};

const godModule: ProjectRule = {
  kind: "project",
  id: "god-module",
  description:
    "Modules must stay below the configured number of top-level functions and methods.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(
      option(ctx, "maxFunctions", 20),
      "maxFunctions"
    );
    return projectSources(ctx).flatMap((file) => {
      const count = functionCount(file.root);
      if (count <= maximum) return [];
      return [
        {
          file: file.path,
          line: 1,
          rule: "god-module",
          identity: `god-module:${file.path}`,
          metrics: { functions: { value: count, worsening: "higher" } },
          message: `${file.path} defines ${count} functions and methods, above the limit of ${maximum}`,
        },
      ];
    });
  },
};

const interfaceSegregation: ProjectRule = {
  kind: "project",
  id: "interface-segregation",
  description:
    "TypeScript interfaces should stay below the configured method count.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(option(ctx, "maxMethods", 5), "maxMethods");
    return projectSources(ctx).flatMap((file) => {
      const findings: Violation[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isInterfaceDeclaration(node)) {
          const count = node.members.filter(ts.isMethodSignature).length;
          if (count > maximum) {
            const line =
              file.root.getLineAndCharacterOfPosition(node.getStart(file.root))
                .line + 1;
            findings.push({
              file: file.path,
              line,
              rule: "interface-segregation",
              identity: `interface-segregation:${file.path}:${node.name.text}`,
              metrics: { methods: { value: count, worsening: "higher" } },
              message: `Interface ${node.name.text} has ${count} methods, above the limit of ${maximum}`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.root);
      return findings;
    });
  },
};

function topLevelTypes<T extends ParsedFile>(file: T) {
  return file.root.statements.flatMap((statement) => {
    if (
      !ts.isInterfaceDeclaration(statement) &&
      !ts.isTypeAliasDeclaration(statement)
    )
      return [];
    return [{ file, node: statement, name: statement.name }];
  });
}

function projectRelativePath(root: string, fileName: string): string | null {
  const relative = path.relative(root, path.resolve(fileName));
  if (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  )
    return relative.split(path.sep).join("/");
  return null;
}

function projectConfigFiles(ctx: ProjectContext): string[] {
  const available = new Set(ctx.listFilesOutsideScan?.(".") ?? ctx.listFiles());
  for (const rootConfig of ["tsconfig.json", "jsconfig.json"])
    if (ctx.read(rootConfig) !== null) available.add(rootConfig);
  const configs = [...available].filter((file) =>
    /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(file)
  );
  return configs
    .filter((file) => {
      if (path.posix.basename(file) !== "jsconfig.json") return true;
      const sibling = path.posix.join(
        path.posix.dirname(file),
        "tsconfig.json"
      );
      return !available.has(sibling);
    })
    .sort((left, right) => left.localeCompare(right));
}

interface ProjectConfiguration {
  options: ts.CompilerOptions;
  files: Set<string>;
  dependencies: Set<string>;
}

function projectConfiguration(
  ctx: ProjectContext,
  configName: string | null
): ProjectConfiguration {
  const fallback: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    target: ts.ScriptTarget.Latest,
  };
  if (configName === null || ctx.read(configName) === null)
    return {
      options: fallback,
      files: new Set(),
      dependencies: new Set(),
    };
  const dependencies = new Set<string>();
  const configPath = (fileName: string) =>
    path.relative(ctx.root, path.resolve(fileName)).split(path.sep).join("/");
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    readFile(fileName) {
      const relative = configPath(fileName);
      const inProject = projectRelativePath(ctx.root, fileName) !== null;
      if (inProject || /\.json$/i.test(fileName)) {
        const text = ctx.read(relative);
        dependencies.add(relative);
        if (text !== null || inProject) return text ?? undefined;
      }
      return ts.sys.readFile(fileName);
    },
    fileExists(fileName) {
      const relative = configPath(fileName);
      const inProject = projectRelativePath(ctx.root, fileName) !== null;
      if (inProject || /\.json$/i.test(fileName)) {
        dependencies.add(relative);
        const exists = ctx.read(relative) !== null;
        if (exists || inProject) return exists;
      }
      return ts.sys.fileExists(fileName);
    },
    readDirectory(rootDir, extensions, excludes, includes, depth) {
      const root = path.resolve(rootDir);
      const includePatterns = includes.length ? includes : ["**/*"];
      const excludePatterns = excludes ?? [];
      return (ctx.listFilesOutsideScan?.(".") ?? ctx.listFiles())
        .filter((file) => {
          const absolute = path.resolve(ctx.root, file);
          if (projectRelativePath(ctx.root, absolute) === null) return false;
          const relative = path
            .relative(root, absolute)
            .split(path.sep)
            .join("/");
          if (
            extensions.length > 0 &&
            !extensions.some((extension) => relative.endsWith(extension))
          )
            return false;
          if (depth !== undefined && relative.split("/").length > depth + 1)
            return false;
          const matches = (pattern: string) => {
            const normalized = path.posix.normalize(
              pattern.replace(/\\/g, "/")
            );
            return (
              matchesPattern(relative, normalized) ||
              (!/[*?{]/.test(normalized) &&
                relative.startsWith(`${normalized}/`))
            );
          };
          return (
            includePatterns.some(matches) && !excludePatterns.some(matches)
          );
        })
        .map((file) => path.resolve(ctx.root, file));
    },
    onUnRecoverableConfigFileDiagnostic() {},
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(ctx.root, configName),
    fallback,
    host
  );
  return {
    options: parsed?.options ?? fallback,
    dependencies,
    files: new Set(
      (parsed?.fileNames ?? []).flatMap((fileName) => {
        const file = projectRelativePath(ctx.root, fileName);
        return file === null ? [] : [file];
      })
    ),
  };
}

function typeProgram(
  ctx: ProjectContext,
  files: ParsedFile[],
  options: ts.CompilerOptions
): ts.Program {
  const compilerHost = ts.createCompilerHost(options);
  const projectDirectories = new Set([path.resolve(ctx.root)]);
  for (const file of ctx.listFilesOutsideScan?.(".") ?? ctx.listFiles()) {
    let directory = path.dirname(path.join(ctx.root, file));
    while (projectRelativePath(ctx.root, directory) !== null) {
      projectDirectories.add(path.resolve(directory));
      const parent = path.dirname(directory);
      if (
        parent === directory ||
        path.resolve(directory) === path.resolve(ctx.root)
      )
        break;
      directory = parent;
    }
  }
  const originalFileExists = compilerHost.fileExists.bind(compilerHost);
  const originalReadFile = compilerHost.readFile.bind(compilerHost);
  const originalGetSourceFile = compilerHost.getSourceFile.bind(compilerHost);
  const originalDirectoryExists =
    compilerHost.directoryExists?.bind(compilerHost);
  compilerHost.getCurrentDirectory = () => ctx.root;
  compilerHost.fileExists = (fileName) => {
    const relative = projectRelativePath(ctx.root, fileName);
    return relative !== null
      ? ctx.read(relative) !== null
      : originalFileExists(fileName);
  };
  compilerHost.readFile = (fileName) => {
    const relative = projectRelativePath(ctx.root, fileName);
    return relative !== null
      ? (ctx.read(relative) ?? undefined)
      : originalReadFile(fileName);
  };
  compilerHost.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile
  ) => {
    const relative = projectRelativePath(ctx.root, fileName);
    if (relative === null)
      return originalGetSourceFile(
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile
      );
    const text = ctx.read(relative);
    if (text === null) return undefined;
    return ts.createSourceFile(
      fileName,
      text,
      languageVersion,
      true,
      scriptKind(fileName)
    );
  };
  if (originalDirectoryExists)
    compilerHost.directoryExists = (directory) => {
      if (projectDirectories.has(path.resolve(directory))) return true;
      return originalDirectoryExists(directory);
    };
  return ts.createProgram({
    rootNames: files.map((file) => path.join(ctx.root, file.path)),
    options,
    host: compilerHost,
  });
}

interface CheckedParsedFile extends ParsedFile {
  checker: ts.TypeChecker;
}

const checkedFileCache = new Map<
  string,
  { signature: string; files: CheckedParsedFile[] }
>();

function checkedProjectFiles(ctx: ProjectContext): CheckedParsedFile[] {
  const files = projectSources(ctx);
  const configs = projectConfigFiles(ctx);
  const projectConfigs = configs.map((config) => ({
    path: config,
    directory: path.posix.dirname(config),
    configuration: projectConfiguration(ctx, config),
  }));
  const allFiles = ctx.listFilesOutsideScan?.(".") ?? ctx.listFiles();
  const signature = createHash("sha256");
  signature.update(ctx.root);
  signature.update(
    JSON.stringify({
      selectedSources: files.map((file) => file.path).sort(),
      scan: ctx.config.scan,
      ignore: ctx.config.ignore,
      tests: ctx.config.tests,
    })
  );
  const configDependencies = projectConfigs.flatMap(({ configuration }) => [
    ...configuration.dependencies,
  ]);
  const configDependencySet = new Set(configDependencies);
  for (const name of [
    ...new Set([...allFiles, ...configs, ...configDependencies]),
  ].sort()) {
    if (
      !SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension)) &&
      path.posix.basename(name) !== "package.json" &&
      !/(?:^|\/)(?:tsconfig|jsconfig)[^/]*\.json$/.test(name) &&
      !configDependencySet.has(name)
    )
      continue;
    const text = ctx.read(name);
    signature.update(name).update(text === null ? "\0missing" : `\0${text}`);
  }
  const cacheSignature = signature.digest("hex");
  const cached = checkedFileCache.get(ctx.root);
  if (cached?.signature === cacheSignature) return cached.files;
  const groups = new Map<string | null, ParsedFile[]>();
  for (const file of files) {
    const owner =
      projectConfigs
        .filter(({ configuration }) => configuration.files.has(file.path))
        .sort(
          (left, right) => right.directory.length - left.directory.length
        )[0]?.path ?? null;
    const group = groups.get(owner) ?? [];
    group.push(file);
    groups.set(owner, group);
  }

  const checked: CheckedParsedFile[] = [];
  for (const [config, roots] of groups) {
    const program = typeProgram(
      ctx,
      roots,
      projectConfiguration(ctx, config).options
    );
    const checker = program.getTypeChecker();
    for (const file of roots)
      checked.push({
        ...file,
        root:
          program.getSourceFile(path.join(ctx.root, file.path)) ?? file.root,
        checker,
      });
  }
  checkedFileCache.set(ctx.root, { signature: cacheSignature, files: checked });
  return checked;
}

function symbolDeclarationKeys(
  ctx: ProjectContext,
  symbol: ts.Symbol
): Set<string> {
  return new Set(
    (symbol.declarations ?? []).flatMap((declaration) => {
      const file = projectRelativePath(
        ctx.root,
        declaration.getSourceFile().fileName
      );
      return file === null
        ? []
        : [`${file}:${declaration.getStart()}:${declaration.end}`];
    })
  );
}

function symbolsMatch(
  ctx: ProjectContext,
  left: ts.Symbol,
  right: ts.Symbol
): boolean {
  const rightKeys = symbolDeclarationKeys(ctx, right);
  return [...symbolDeclarationKeys(ctx, left)].some((key) =>
    rightKeys.has(key)
  );
}

function moduleSourceFiles(
  ctx: ProjectContext,
  checker: ts.TypeChecker,
  specifier: ts.Expression
): string[] {
  const moduleSymbol = checker.getSymbolAtLocation(specifier);
  if (!moduleSymbol) return [];
  return [
    ...new Set(
      (moduleSymbol.declarations ?? []).flatMap((declaration) => {
        const file = projectRelativePath(
          ctx.root,
          declaration.getSourceFile().fileName
        );
        return file === null ? [] : [file];
      })
    ),
  ];
}

function typeOnlyExport(declaration: ts.Declaration): boolean {
  if (ts.isExportSpecifier(declaration))
    return (
      declaration.isTypeOnly ||
      (ts.isExportDeclaration(declaration.parent.parent) &&
        declaration.parent.parent.isTypeOnly)
    );
  return ts.isExportDeclaration(declaration) && declaration.isTypeOnly;
}

function symbolIsAbstractSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined
): boolean {
  const declarations = symbol?.declarations ?? [];
  if (declarations.length > 0 && declarations.every(typeOnlyExport))
    return true;
  const resolved = resolveAlias(checker, symbol);
  const resolvedDeclarations = resolved?.declarations ?? [];
  return (
    resolvedDeclarations.length > 0 &&
    resolvedDeclarations.every((declaration) => {
      if (
        ts.isInterfaceDeclaration(declaration) ||
        ts.isTypeAliasDeclaration(declaration)
      )
        return true;
      return (
        ts.isClassDeclaration(declaration) &&
        ts.canHaveModifiers(declaration) &&
        (ts
          .getModifiers(declaration)
          ?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword
          ) ??
          false)
      );
    })
  );
}

function symbolIsAbstract(checker: ts.TypeChecker, node: ts.Node): boolean {
  return symbolIsAbstractSymbol(checker, checker.getSymbolAtLocation(node));
}

function moduleExportIsAbstract(
  checker: ts.TypeChecker,
  moduleSpecifier: ts.Expression,
  name: string
): boolean {
  const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
  const exported = moduleSymbol
    ? checker
        .getExportsOfModule(resolveAlias(checker, moduleSymbol) ?? moduleSymbol)
        .find((symbol) => symbol.getName() === name)
    : undefined;
  return symbolIsAbstractSymbol(checker, exported);
}

function exportIsAbstract(
  checker: ts.TypeChecker,
  declaration: ts.ExportDeclaration
): boolean {
  if (declaration.isTypeOnly) return true;
  const clause = declaration.exportClause;
  if (!clause) {
    const moduleSymbol = checker.getSymbolAtLocation(
      declaration.moduleSpecifier!
    );
    const exports = moduleSymbol
      ? checker.getExportsOfModule(
          resolveAlias(checker, moduleSymbol) ?? moduleSymbol
        )
      : [];
    return (
      exports.length > 0 &&
      exports.every((symbol) => symbolIsAbstractSymbol(checker, symbol))
    );
  }
  if (ts.isNamedExports(clause))
    return clause.elements.every(
      (element) => element.isTypeOnly || symbolIsAbstract(checker, element.name)
    );
  const namespace = checker.getSymbolAtLocation(clause.name);
  const exports = namespace
    ? checker.getExportsOfModule(resolveAlias(checker, namespace) ?? namespace)
    : [];
  return (
    exports.length > 0 &&
    exports.every((symbol) => symbolIsAbstractSymbol(checker, symbol))
  );
}

function importIsAbstract(
  checker: ts.TypeChecker,
  declaration: ts.ImportDeclaration
): boolean {
  const clause = declaration.importClause;
  if (clause?.isTypeOnly) return true;
  if (!clause) return false;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    const namespace = checker.getSymbolAtLocation(clause.namedBindings.name);
    const exports = namespace
      ? checker.getExportsOfModule(
          resolveAlias(checker, namespace) ?? namespace
        )
      : [];
    return (
      exports.length > 0 &&
      exports.every((symbol) => symbolIsAbstractSymbol(checker, symbol))
    );
  }
  const defaultIsAbstract =
    !clause.name || symbolIsAbstract(checker, clause.name);
  if (!defaultIsAbstract) return false;
  if (!clause.namedBindings || ts.isNamespaceImport(clause.namedBindings))
    return defaultIsAbstract;
  return clause.namedBindings.elements.every(
    (element) =>
      element.isTypeOnly ||
      moduleExportIsAbstract(
        checker,
        declaration.moduleSpecifier,
        element.propertyName?.text ?? element.name.text
      )
  );
}

function exportedSurface(
  checker: ts.TypeChecker,
  source: ts.SourceFile
): boolean {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  return Boolean(
    moduleSymbol && checker.getExportsOfModule(moduleSymbol).length
  );
}

const abstractness: ProjectRule = {
  kind: "project",
  id: "abstractness",
  description:
    "Stable exported modules should be used through abstract TypeScript types.",
  defaultLevel: "off",
  check(ctx) {
    const minFanIn = positiveInteger(option(ctx, "minFanIn", 10), "minFanIn");
    const distanceThreshold = option(ctx, "distanceThreshold", 0.85);
    if (
      typeof distanceThreshold !== "number" ||
      !Number.isFinite(distanceThreshold) ||
      distanceThreshold <= 0 ||
      distanceThreshold > 1
    )
      throw new Error("distanceThreshold must be greater than 0 and at most 1");
    const files = checkedProjectFiles(ctx);
    const paths = new Set(files.map((file) => file.path));
    const incoming = new Map<string, Map<string, boolean>>();
    const outgoing = new Map<string, Set<string>>();
    const addDependency = (from: string, to: string, isAbstract: boolean) => {
      if (!paths.has(to)) return;
      const clients = incoming.get(to) ?? new Map<string, boolean>();
      clients.set(from, (clients.get(from) ?? true) && isAbstract);
      incoming.set(to, clients);
      const dependencies = outgoing.get(from) ?? new Set<string>();
      dependencies.add(to);
      outgoing.set(from, dependencies);
    };
    for (const file of files) {
      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier
        ) {
          const isAbstract = ts.isImportDeclaration(node)
            ? importIsAbstract(file.checker, node)
            : exportIsAbstract(file.checker, node);
          for (const target of moduleSourceFiles(
            ctx,
            file.checker,
            node.moduleSpecifier
          ))
            addDependency(file.path, target, isAbstract);
        } else if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isStringLiteralLike(node.arguments[0]!)
        ) {
          for (const target of moduleSourceFiles(
            ctx,
            file.checker,
            node.arguments[0]!
          ))
            addDependency(file.path, target, false);
        }
        ts.forEachChild(node, visit);
      };
      visit(file.root);
    }
    return files.flatMap((file) => {
      if (!exportedSurface(file.checker, file.root)) return [];
      const clients = incoming.get(file.path);
      const ca = clients?.size ?? 0;
      if (ca < minFanIn) return [];
      const abstractClients = [...(clients?.values() ?? [])].filter(
        Boolean
      ).length;
      const abstractness = abstractClients / ca;
      const ce = outgoing.get(file.path)?.size ?? 0;
      const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
      const distance = Math.abs(abstractness + instability - 1);
      if (distance < distanceThreshold) return [];
      return [
        {
          file: file.path,
          line: 1,
          rule: "abstractness",
          identity: `abstractness:${file.path}`,
          metrics: { distance: { value: distance, worsening: "higher" } },
          message: `${file.path} is ${distance.toFixed(2)} from the abstractness and instability balance (A=${abstractness.toFixed(2)}, I=${instability.toFixed(2)}, fan-in=${ca})`,
        },
      ];
    });
  },
};

function concreteClassImports(
  checker: ts.TypeChecker,
  declaration: ts.ImportDeclaration
): Array<{ name: string; declarations: ts.ClassLikeDeclaration[] }> {
  const clause = declaration.importClause;
  if (!clause) return [];
  const imported: Array<{ symbol: ts.Symbol | undefined; name: string }> = [];
  if (clause.name)
    imported.push({
      symbol: checker.getSymbolAtLocation(clause.name),
      name: clause.name.text,
    });
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
    for (const element of clause.namedBindings.elements)
      imported.push({
        symbol: checker.getSymbolAtLocation(element.name),
        name: element.propertyName?.text ?? element.name.text,
      });
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
    const moduleSymbol = checker.getSymbolAtLocation(
      declaration.moduleSpecifier
    );
    const exports = moduleSymbol
      ? checker.getExportsOfModule(
          resolveAlias(checker, moduleSymbol) ?? moduleSymbol
        )
      : [];
    imported.push(
      ...exports.map((symbol) => ({ symbol, name: symbol.getName() }))
    );
  }
  return imported.flatMap(({ symbol, name }) => {
    const declarations = concreteClassDeclarations(checker, symbol);
    return declarations.length > 0 ? [{ name, declarations }] : [];
  });
}

const dependencyInversion: ProjectRule = {
  kind: "project",
  id: "dependency-inversion",
  description:
    "High-level modules should not import concrete classes from implementation layers.",
  defaultLevel: "off",
  check(ctx) {
    if (
      ctx.options.highLevelLayers === undefined &&
      ctx.options.implementationLayers === undefined
    )
      return [];
    const layers = (name: string) => {
      const value = option<unknown>(ctx, name, []);
      if (
        !Array.isArray(value) ||
        value.some((layer) => typeof layer !== "string")
      )
        throw new Error(`${name} must be an array of layer names`);
      if (value.length === 0)
        throw new Error(`${name} must name at least one layer`);
      for (const layer of value)
        if (!ctx.hasLayer(layer))
          throw new Error(`${name} references unknown layer "${layer}"`);
      return value as string[];
    };
    const highLevelLayers = layers("highLevelLayers");
    const implementationLayers = layers("implementationLayers");
    const files = checkedProjectFiles(ctx);
    return files.flatMap((file) => {
      if (!highLevelLayers.some((layer) => ctx.inLayer(file.path, layer)))
        return [];
      const findings: Violation[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
          const concrete = concreteClassImports(file.checker, node).filter(
            ({ declarations }) =>
              declarations.some((declaration) => {
                const target = projectRelativePath(
                  ctx.root,
                  declaration.getSourceFile().fileName
                );
                return (
                  target !== null &&
                  implementationLayers.some((layer) =>
                    ctx.inLayer(target, layer)
                  )
                );
              })
          );
          if (concrete.length > 0) {
            const line =
              file.root.getLineAndCharacterOfPosition(node.getStart(file.root))
                .line + 1;
            findings.push({
              file: file.path,
              line,
              rule: "dependency-inversion",
              identity: `dependency-inversion:${file.path}:${node.getStart(file.root)}`,
              message: `${file.path} imports concrete ${concrete.map(({ name }) => name).join(", ")} from an implementation layer; depend on an interface or abstract class`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.root);
      return findings;
    });
  },
};

function resolveAlias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined
): ts.Symbol | undefined {
  while (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    const target = checker.getAliasedSymbol(symbol);
    if (target === symbol) break;
    symbol = target;
  }
  return symbol;
}

function concreteClassDeclarations(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  seen = new Set<ts.Symbol>()
): ts.ClassLikeDeclaration[] {
  const resolved = resolveAlias(checker, symbol);
  if (!resolved || seen.has(resolved)) return [];
  seen.add(resolved);
  const isConcrete = (candidate: ts.ClassLikeDeclaration) =>
    !ts
      .getModifiers(candidate)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword);
  return (resolved.declarations ?? []).flatMap((declaration) => {
    if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration))
      return isConcrete(declaration) ? [declaration] : [];
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const initializer = unwrapTransparentExpression(declaration.initializer);
      if (ts.isClassExpression(initializer))
        return isConcrete(initializer) ? [initializer] : [];
      if (ts.isIdentifier(initializer))
        return concreteClassDeclarations(
          checker,
          checker.getSymbolAtLocation(initializer),
          seen
        );
    }
    return [];
  });
}

function targetSymbol(
  checker: ts.TypeChecker,
  node: ts.Node
): ts.Symbol | undefined {
  return resolveAlias(checker, checker.getSymbolAtLocation(node));
}

function exportedSymbols(
  ctx: ProjectContext,
  checker: ts.TypeChecker,
  source: ts.SourceFile
): Set<string> {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return new Set();
  return new Set(
    checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => resolveAlias(checker, symbol))
      .filter((symbol): symbol is ts.Symbol => symbol !== undefined)
      .flatMap((symbol) => [...symbolDeclarationKeys(ctx, symbol)])
  );
}

function typeReferenceNodes(source: ts.SourceFile): ts.Node[] {
  const references: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isTypeReferenceNode(node)) references.push(node.typeName);
    else if (ts.isExpressionWithTypeArguments(node))
      references.push(node.expression);
    else if (ts.isImportTypeNode(node) && node.qualifier)
      references.push(node.qualifier);
    else if (ts.isTypeQueryNode(node)) references.push(node.exprName);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return references;
}

function exportedDeclarations(
  ctx: ProjectContext,
  checker: ts.TypeChecker,
  source: ts.SourceFile
): Array<{
  symbol: ts.Symbol;
  declaration: ts.Declaration;
  name: ts.Identifier | undefined;
  displayName: string;
}> {
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) return [];
  const declarations = new Map<
    string,
    {
      symbol: ts.Symbol;
      declaration: ts.Declaration;
      name: ts.Identifier | undefined;
      displayName: string;
    }
  >();
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = resolveAlias(checker, exported);
    if (!symbol) continue;
    for (const declaration of symbol.declarations ?? []) {
      if (declaration.getSourceFile() !== source) continue;
      const declarationName = (declaration as ts.NamedDeclaration).name;
      const name =
        declarationName && ts.isIdentifier(declarationName)
          ? declarationName
          : undefined;
      const modifiers = ts.canHaveModifiers(declaration)
        ? ts.getModifiers(declaration)
        : undefined;
      const anonymousDefault =
        !name &&
        modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword
        );
      if (name || anonymousDefault || ts.isExportAssignment(declaration)) {
        const displayName = name?.text ?? "default";
        const key = `${projectRelativePath(ctx.root, source.fileName)}:${displayName}`;
        if (!declarations.has(key))
          declarations.set(key, {
            symbol,
            declaration,
            name,
            displayName,
          });
      }
    }
  }
  return [...declarations.values()];
}

function primitiveKind(type: ts.TypeNode | undefined): string | undefined {
  if (!type) return undefined;
  switch (type.kind) {
    case ts.SyntaxKind.StringKeyword:
      return "string";
    case ts.SyntaxKind.NumberKeyword:
      return "number";
    case ts.SyntaxKind.BooleanKeyword:
      return "boolean";
    case ts.SyntaxKind.BigIntKeyword:
      return "bigint";
    case ts.SyntaxKind.SymbolKeyword:
      return "symbol";
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
    const name = type.typeName.text;
    if (["string", "number", "boolean", "bigint", "symbol"].includes(name))
      return name;
  }
  return undefined;
}

const primitiveObsession: ProjectRule = {
  kind: "project",
  id: "primitive-obsession",
  description:
    "Function signatures should group repeated primitive parameters into domain types.",
  defaultLevel: "off",
  check(ctx) {
    const minCount = positiveInteger(option(ctx, "minCount", 3), "minCount");
    const types = option(ctx, "types", [
      "string",
      "number",
      "boolean",
      "bigint",
      "symbol",
    ]);
    if (
      !Array.isArray(types) ||
      types.some(
        (type) =>
          typeof type !== "string" ||
          !["string", "number", "boolean", "bigint", "symbol"].includes(type)
      )
    )
      throw new Error("types must be an array of primitive type names");
    const enabledTypes = new Set(types as string[]);
    return projectSources(ctx).flatMap((file) => {
      const findings: Violation[] = [];
      const visit = (node: ts.Node) => {
        if (ts.isFunctionLike(node) && hasBody(node)) {
          const counts = new Map<string, number>();
          for (const parameter of node.parameters) {
            const kind = primitiveKind(parameter.type);
            if (kind && enabledTypes.has(kind))
              counts.set(kind, (counts.get(kind) ?? 0) + 1);
          }
          const total = [...counts.values()].reduce(
            (sum, count) => sum + count,
            0
          );
          if (total >= minCount) {
            const line =
              file.root.getLineAndCharacterOfPosition(node.getStart(file.root))
                .line + 1;
            findings.push({
              file: file.path,
              line,
              rule: "primitive-obsession",
              identity: `${file.path}:${node.getStart(file.root)}:${functionName(node)}`,
              metrics: { parameters: { value: total, worsening: "higher" } },
              message: `${functionName(node)} takes ${total} primitive parameters (${[...counts].map(([kind, count]) => `${count} ${kind}`).join(", ")}), at or above the limit of ${minCount}`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.root);
      return findings;
    });
  },
};

function environmentKey(node: ts.Node): string | undefined {
  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "env" &&
    ts.isIdentifier(node.expression.expression) &&
    ["process", "Bun"].includes(node.expression.expression.text) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  if (ts.isPropertyAccessExpression(node)) {
    const receiver = node.expression;
    if (
      ts.isPropertyAccessExpression(receiver) &&
      receiver.name.text === "env" &&
      ((ts.isIdentifier(receiver.expression) &&
        ["process", "Bun"].includes(receiver.expression.text)) ||
        (ts.isMetaProperty(receiver.expression) &&
          receiver.expression.keywordToken === ts.SyntaxKind.ImportKeyword))
    )
      return node.name.text;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "get" &&
    ts.isPropertyAccessExpression(node.expression.expression) &&
    ts.isIdentifier(node.expression.expression.expression) &&
    node.expression.expression.expression.text === "Deno" &&
    node.expression.expression.name.text === "env" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!)
  )
    return node.arguments[0]!.text;
  return undefined;
}

function isEnvironmentObject(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === "env" &&
    ((ts.isIdentifier(node.expression) &&
      ["process", "Bun"].includes(node.expression.text)) ||
      (ts.isMetaProperty(node.expression) &&
        node.expression.keywordToken === ts.SyntaxKind.ImportKeyword))
  );
}

function environmentBindingKeys(
  declaration: ts.VariableDeclaration
): Array<{ name: string; node: ts.Node }> {
  if (
    !declaration.initializer ||
    !isEnvironmentObject(declaration.initializer) ||
    !ts.isObjectBindingPattern(declaration.name)
  )
    return [];
  const keys: Array<{ name: string; node: ts.Node }> = [];
  for (const element of declaration.name.elements) {
    if (element.dotDotDotToken) continue;
    const property = element.propertyName ?? element.name;
    if (ts.isIdentifier(property) || ts.isStringLiteralLike(property))
      keys.push({ name: property.text, node: property });
  }
  return keys;
}

const scatteredConfig: ProjectRule = {
  kind: "project",
  id: "scattered-config",
  description:
    "Environment configuration should be read from a small number of modules.",
  defaultLevel: "off",
  check(ctx) {
    const minFiles = positiveInteger(option(ctx, "minFiles", 3), "minFiles");
    const ignored: unknown = option(ctx, "ignore", []);
    if (
      !Array.isArray(ignored) ||
      ignored.some((name) => typeof name !== "string")
    )
      throw new Error("ignore must be an array of environment variable names");
    const reads = new Map<string, Map<string, number>>();
    for (const file of projectSources(ctx)) {
      const addRead = (name: string, node: ts.Node) => {
        if ((ignored as string[]).includes(name)) return;
        const locations = reads.get(name) ?? new Map<string, number>();
        if (!locations.has(file.path))
          locations.set(
            file.path,
            file.root.getLineAndCharacterOfPosition(node.getStart(file.root))
              .line + 1
          );
        reads.set(name, locations);
      };
      const visit = (node: ts.Node) => {
        const name = environmentKey(node);
        if (name) addRead(name, node);
        if (ts.isVariableDeclaration(node))
          for (const binding of environmentBindingKeys(node))
            addRead(binding.name, binding.node);
        ts.forEachChild(node, visit);
      };
      visit(file.root);
    }
    return [...reads].flatMap(([name, locations]) => {
      if (locations.size < minFiles) return [];
      const [file, line] = [...locations].sort(([left], [right]) =>
        left.localeCompare(right)
      )[0]!;
      return [
        {
          file,
          line,
          rule: "scattered-config",
          identity: `scattered-config:${name}`,
          metrics: { files: { value: locations.size, worsening: "higher" } },
          message: `Environment setting ${name} is read in ${locations.size} files (limit ${minFiles - 1})`,
        },
      ];
    });
  },
};

const moduleCohesion: ProjectRule = {
  kind: "project",
  id: "module-cohesion",
  description:
    "Exported declarations in one module should form a connected group.",
  defaultLevel: "off",
  check(ctx) {
    const minExports = positiveInteger(
      option(ctx, "minExports", 5),
      "minExports"
    );
    const maxComponents = positiveInteger(
      option(ctx, "maxComponents", 2),
      "maxComponents"
    );
    return checkedProjectFiles(ctx).flatMap((file) => {
      const candidates = exportedDeclarations(ctx, file.checker, file.root);
      if (candidates.length < minExports) return [];
      const parent = candidates.map((_, index) => index);
      const find = (index: number): number =>
        parent[index] === index
          ? index
          : (parent[index] = find(parent[index]!));
      const join = (left: number, right: number) => {
        parent[find(left)] = find(right);
      };
      const owners = new Map<string, number>();
      candidates.forEach((candidate, index) => {
        for (const key of symbolDeclarationKeys(ctx, candidate.symbol))
          owners.set(key, index);
      });
      candidates.forEach((candidate, index) => {
        const visit = (node: ts.Node) => {
          if (ts.isIdentifier(node)) {
            const symbol = targetSymbol(file.checker, node);
            if (symbol)
              for (const key of symbolDeclarationKeys(ctx, symbol)) {
                const owner = owners.get(key);
                if (owner !== undefined && owner !== index) join(index, owner);
              }
          }
          ts.forEachChild(node, visit);
        };
        visit(candidate.declaration);
      });
      const components = new Set(candidates.map((_, index) => find(index)))
        .size;
      if (components <= maxComponents) return [];
      const declaration = candidates[0]!.declaration;
      const line =
        file.root.getLineAndCharacterOfPosition(declaration.getStart(file.root))
          .line + 1;
      return [
        {
          file: file.path,
          line,
          rule: "module-cohesion",
          identity: `module-cohesion:${file.path}`,
          metrics: { groups: { value: components, worsening: "higher" } },
          message: `${file.path} has ${components} disconnected groups across ${candidates.length} exports (max ${maxComponents})`,
        },
      ];
    });
  },
};

interface LineRange {
  start: number;
  end: number;
}

function indentationUnit(text: string): number {
  const widths = text.split(/\r?\n/).flatMap((line) => {
    const prefix = /^[\t ]+(?=\S)/.exec(line)?.[0];
    return prefix ? [prefix.replace(/\t/g, "  ").length] : [];
  });
  const gcd = (left: number, right: number): number =>
    right === 0 ? left : gcd(right, left % right);
  return widths.reduce(gcd, 0) || 2;
}

function publicTopLevelNodes(file: ParsedFile): Set<ts.Node> {
  const statements = new Set<ts.Node>(
    file.root.statements.filter(hasExportModifier)
  );
  const declarationsByName = new Map<string, ts.Node>();
  for (const statement of file.root.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        for (const name of bindingNames(declaration.name))
          declarationsByName.set(name, declaration);
      continue;
    }
    const name =
      ts.isClassDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
        ? statement.name
        : undefined;
    if (name && ts.isIdentifier(name))
      declarationsByName.set(name.text, statement);
  }
  const addLocalExport = (name: string) => {
    const visited = new Set<string>();
    let declaration = declarationsByName.get(name);
    while (declaration && !visited.has(name)) {
      visited.add(name);
      if (ts.isClassDeclaration(declaration) || ts.isStatement(declaration)) {
        statements.add(declaration);
        return;
      }
      if (!ts.isVariableDeclaration(declaration)) return;
      statements.add(declaration);
      if (!declaration.initializer) return;
      const initializer = unwrapTransparentExpression(declaration.initializer);
      if (ts.isClassExpression(initializer)) return;
      if (!ts.isIdentifier(initializer)) return;
      name = initializer.text;
      declaration = declarationsByName.get(name);
    }
  };
  for (const statement of file.root.statements) {
    if (
      ts.isExportAssignment(statement) &&
      ts.isIdentifier(statement.expression)
    )
      addLocalExport(statement.expression.text);
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier ||
      !statement.exportClause ||
      !ts.isNamedExports(statement.exportClause)
    )
      continue;
    for (const specifier of statement.exportClause.elements) {
      const localName = specifier.propertyName?.text ?? specifier.name.text;
      addLocalExport(localName);
    }
  }
  return statements;
}

function publicMemberIndentations(file: ParsedFile): Set<number> {
  const indentations = new Set<number>();
  const record = (member: ts.Node) => {
    const memberName = (member as ts.NamedDeclaration).name;
    const modifiers = ts.canHaveModifiers(member)
      ? ts.getModifiers(member)
      : undefined;
    if (
      modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
      ) ||
      (memberName !== undefined && ts.isPrivateIdentifier(memberName))
    )
      return;
    const line = file.root.getLineAndCharacterOfPosition(
      member.getStart(file.root)
    ).line;
    const start = file.root.getPositionOfLineAndCharacter(line, 0);
    const indentation = file.root.text.slice(start, member.getStart(file.root));
    if (!/^\s*$/.test(indentation)) return;
    indentations.add(indentation.replace(/\t/g, "  ").length);
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isMethodSignature(node) ||
      ts.isPropertySignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isPropertyDeclaration(node)
    ) {
      record(node);
      if (ts.isMethodDeclaration(node)) return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of publicTopLevelNodes(file)) visit(statement);
  if (indentations.size === 0)
    indentations.add(indentationUnit(file.root.text));
  return indentations;
}

export function unstableInterfaceMemberIndentations(
  filePath: string,
  text: string
): ReadonlySet<number> {
  return publicMemberIndentations({
    path: filePath,
    root: ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(filePath)
    ),
    lines: sourceLines(text),
  });
}

function unstableInterfaceChanges(
  log: string,
  rangesByFile: ReadonlyMap<string, readonly LineRange[]>,
  memberIndentsByFile: ReadonlyMap<string, ReadonlySet<number>> = new Map()
): Map<string, { commits: Set<number>; line: number }> {
  const changedByFile = new Map<
    string,
    { commits: Set<number>; line: number }
  >();
  let commit = -1;
  let file: string | undefined;
  let line: number | undefined;
  let removedLines: string[] = [];
  const mark = (name: string, changedLine: number) => {
    const changes = changedByFile.get(name) ?? {
      commits: new Set<number>(),
      line: changedLine,
    };
    changes.commits.add(commit);
    changes.line = Math.min(changes.line, changedLine);
    changedByFile.set(name, changes);
  };
  const flushHunk = () => {
    if (!file || line === undefined || removedLines.length === 0) {
      removedLines = [];
      return;
    }
    const signatureRemoved = removedLines.some((removed) => {
      const text = removed.trim();
      const topLevel = !/^\s/.test(removed);
      if (!text || /^private\b|^#/.test(text)) return false;
      const methodSignature =
        /^(?:(?:public|protected|static|abstract|readonly|override|async)\s+)*(?:get\s+|set\s+)?(?:[$\w]+|["'][^"']+["'])\s*(?:<[^;{}]+>)?\s*\([^;{}]*\)\s*(?::\s*[^;{=]+)?;?$/.test(
          text
        );
      const hasMethodModifier =
        /^(?:(?:public|protected|static|abstract|readonly|override|async)\s+)/.test(
          text
        );
      const hasReturnType = /\)\s*:\s*[^;{=]+;?$/.test(text);
      const indentation = /^\s*/.exec(removed)?.[0] ?? "";
      const indentWidth = indentation.replace(/\t/g, "  ").length;
      const expectedIndents = memberIndentsByFile.get(file!);
      const declaredMethod =
        hasMethodModifier ||
        hasReturnType ||
        expectedIndents?.has(indentWidth) ||
        (!expectedIndents?.size && indentWidth > 0 && indentWidth <= 4);
      const propertySignature =
        /^(?:(?:public|protected|static|abstract|readonly|override)\s+)*(?:[$\w]+|["'][^"']+["'])\s*(?:[?!]\s*)?:\s*[^;{=]+;?$/.test(
          text
        );
      const validPropertySignature = (() => {
        if (!propertySignature) return false;
        const memberText = text.trim();
        for (const prefix of ["interface __Removed {", "class __Removed {"]) {
          const candidate = ts.createSourceFile(
            "removed-signature.ts",
            `${prefix}\n${memberText}\n}`,
            ts.ScriptTarget.Latest,
            true
          );
          const declaration = candidate.statements[0];
          const member =
            declaration &&
            (ts.isInterfaceDeclaration(declaration) ||
              ts.isClassDeclaration(declaration))
              ? declaration.members[0]
              : undefined;
          const parseDiagnostics = (
            candidate as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }
          ).parseDiagnostics;
          if (
            parseDiagnostics.length === 0 &&
            member &&
            (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member))
          )
            return true;
        }
        return false;
      })();
      return (
        (topLevel &&
          /^(?:(?:export|declare|default|abstract)\s+)*(?:class|interface|type|enum|function|const|let|var)\b/.test(
            text
          )) ||
        (methodSignature && declaredMethod) ||
        validPropertySignature ||
        /^export\s+(?:\{|\*|default\b|=)/.test(text)
      );
    });
    if (signatureRemoved) {
      const ranges = rangesByFile.get(file) ?? [];
      const nearest = ranges.reduce(
        (best, range) => {
          const candidate = Math.min(
            Math.abs(line! - range.start),
            Math.abs(line! - range.end)
          );
          return candidate < best.distance
            ? { distance: candidate, line: range.start }
            : best;
        },
        { distance: Number.POSITIVE_INFINITY, line: 1 }
      );
      mark(file, nearest.line);
    }
    removedLines = [];
  };
  for (const entry of log.split("\n")) {
    if (entry.startsWith("\x01")) {
      flushHunk();
      commit++;
      file = undefined;
      line = undefined;
      continue;
    }
    if (entry.startsWith("diff --git ")) {
      flushHunk();
      file = undefined;
      line = undefined;
      continue;
    }
    if (entry.startsWith("+++ b/")) {
      file = entry.slice("+++ b/".length);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(entry);
    if (hunk) {
      flushHunk();
      line = Number(hunk[1]);
      continue;
    }
    if (!file || line === undefined || !rangesByFile.has(file)) continue;
    const added = entry.startsWith("+") && !entry.startsWith("+++");
    const removed = entry.startsWith("-") && !entry.startsWith("---");
    if (!added && !removed && !entry.startsWith(" ")) continue;
    if (added) {
      if (
        (rangesByFile.get(file) ?? []).some(
          (range) => line! >= range.start && line! <= range.end
        )
      )
        mark(file, line);
      line++;
    } else if (removed) removedLines.push(entry.slice(1));
    else line++;
  }
  flushHunk();
  return changedByFile;
}

export function unstableInterfaceChangeCounts(
  log: string,
  rangesByFile: ReadonlyMap<string, readonly LineRange[]>,
  memberIndentsByFile: ReadonlyMap<string, ReadonlySet<number>> = new Map()
): Map<string, number> {
  return new Map(
    [...unstableInterfaceChanges(log, rangesByFile, memberIndentsByFile)].map(
      ([file, changes]) => [file, changes.commits.size]
    )
  );
}

function exportedSignatureRanges(file: ParsedFile): LineRange[] {
  const ranges: LineRange[] = [];
  const add = (node: ts.Node, end = node.end) => {
    const startLine =
      file.root.getLineAndCharacterOfPosition(node.getStart(file.root)).line +
      1;
    const endLine =
      file.root.getLineAndCharacterOfPosition(
        Math.max(node.getStart(file.root), end - 1)
      ).line + 1;
    ranges.push({ start: startLine, end: endLine });
  };
  const members = (node: ts.ClassLikeDeclaration) => {
    for (const member of node.members) {
      if (member.name && ts.isPrivateIdentifier(member.name)) continue;
      const modifiers = ts.canHaveModifiers(member)
        ? ts.getModifiers(member)
        : undefined;
      if (
        modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
        )
      )
        continue;
      const end =
        ts.isFunctionLike(member) && hasBody(member)
          ? member.body.getStart(file.root)
          : ts.isPropertyDeclaration(member) && member.initializer
            ? member.initializer.getStart(file.root)
            : member.end;
      add(member, end);
    }
  };
  for (const statement of file.root.statements)
    if (ts.isExportDeclaration(statement)) add(statement);
  for (const statement of publicTopLevelNodes(file)) {
    if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      add(statement);
    } else if (ts.isClassDeclaration(statement)) {
      if (statement.members.length === 0) add(statement.name ?? statement);
      else members(statement);
    } else if (ts.isFunctionDeclaration(statement)) {
      add(statement, statement.body?.getStart(file.root) ?? statement.end);
    } else if (
      ts.isVariableStatement(statement) ||
      ts.isVariableDeclaration(statement)
    ) {
      const declarations = ts.isVariableStatement(statement)
        ? statement.declarationList.declarations
        : [statement];
      for (const declaration of declarations) {
        const initializer = declaration.initializer
          ? unwrapTransparentExpression(declaration.initializer)
          : undefined;
        if (initializer && ts.isClassExpression(initializer)) {
          members(initializer);
        } else {
          const end =
            initializer &&
            (ts.isArrowFunction(initializer) ||
              ts.isFunctionExpression(initializer))
              ? initializer.body.getStart(file.root)
              : (declaration.type?.end ?? declaration.name.end);
          add(declaration, end);
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      const expression = statement.expression;
      if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression))
        add(expression, expression.body.getStart(file.root));
    }
  }
  return ranges;
}

export function unstableInterfaceSignatureRanges(
  filePath: string,
  text: string
): LineRange[] {
  return exportedSignatureRanges({
    path: filePath,
    root: ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(filePath)
    ),
    lines: sourceLines(text),
  });
}

const unstableInterface: ProjectRule = {
  kind: "project",
  id: "unstable-interface",
  description:
    "Configured public TypeScript signatures should not change in too many recent commits.",
  defaultLevel: "off",
  check(ctx) {
    const include = option(ctx, "include", [
      "**/api.*",
      "**/api/**",
      "**/public/**",
    ]);
    if (
      !Array.isArray(include) ||
      include.some((pattern) => typeof pattern !== "string")
    )
      throw new Error("include must be an array of public API path patterns");
    const window = positiveInteger(option(ctx, "window", 100), "window");
    const minChanges = positiveInteger(
      option(ctx, "minChanges", 5),
      "minChanges"
    );
    const ranges = new Map<string, LineRange[]>();
    for (const file of projectSources(ctx)) {
      if (!matchesAny(file.path, include as string[])) continue;
      const fileRanges = exportedSignatureRanges(file);
      ranges.set(file.path, fileRanges);
    }
    if (ranges.size === 0) return [];
    let log = "";
    try {
      log = execFileSync(
        "git",
        [
          "-C",
          ctx.root,
          "log",
          "--relative",
          "-n",
          String(window),
          "-p",
          "--unified=0",
          "--format=%x01%H",
          "--",
          "*.ts",
          "*.tsx",
          "*.mts",
          "*.cts",
          "*.js",
          "*.jsx",
          "*.mjs",
          "*.cjs",
        ],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
      );
    } catch {
      return [];
    }
    const changesByFile = unstableInterfaceChanges(
      log,
      ranges,
      new Map(
        projectSources(ctx).map((file) => [
          file.path,
          publicMemberIndentations(file),
        ])
      )
    );
    return [...changesByFile].flatMap(([file, details]) => {
      const changes = details.commits.size;
      if (changes < minChanges) return [];
      return [
        {
          file,
          line: details.line,
          rule: "unstable-interface",
          identity: `unstable-interface:${file}`,
          metrics: { changes: { value: changes, worsening: "higher" } },
          message: `${file} public signatures changed in ${changes} of the last ${window} commits (limit ${minChanges - 1})`,
        },
      ];
    });
  },
};

function isInsideImport(node: ts.Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isImportDeclaration(parent) || ts.isImportEqualsDeclaration(parent))
      return true;
  return false;
}

const unusedExport: ProjectRule = {
  kind: "project",
  id: "unused-export",
  description:
    "Exported symbols should have an in-project consumer or belong to a configured entry point.",
  defaultLevel: "off",
  check(ctx) {
    const entryPoints = option(ctx, "entryPoints", ["**/index.*"]);
    if (
      !Array.isArray(entryPoints) ||
      entryPoints.some((entry) => typeof entry !== "string")
    )
      throw new Error("entryPoints must be an array of path patterns");
    const files = checkedProjectFiles(ctx);
    const candidates = files.flatMap((file) => {
      if (matchesAny(file.path, entryPoints as string[])) return [];
      return exportedDeclarations(ctx, file.checker, file.root).map(
        (entry) => ({
          ...entry,
          file,
        })
      );
    });
    const references = files.flatMap((file) => {
      const found: Array<{ node: ts.Node; symbol: ts.Symbol }> = [];
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && !isInsideImport(node)) {
          const symbol = targetSymbol(file.checker, node);
          if (symbol) found.push({ node, symbol });
        }
        if (
          ts.isExportDeclaration(node) &&
          node.moduleSpecifier &&
          !node.exportClause
        ) {
          const moduleSymbol = file.checker.getSymbolAtLocation(
            node.moduleSpecifier
          );
          if (moduleSymbol)
            for (const exported of file.checker.getExportsOfModule(
              moduleSymbol
            )) {
              const symbol = resolveAlias(file.checker, exported);
              if (symbol) found.push({ node, symbol });
            }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.root);
      return found;
    });
    return candidates.flatMap(
      ({ file, declaration, name, displayName, symbol }) => {
        const ownDeclarations = symbol.declarations ?? [declaration];
        const used = references.some(
          (reference) =>
            symbolsMatch(ctx, reference.symbol, symbol) &&
            !ownDeclarations.some(
              (own) =>
                own.getSourceFile() === reference.node.getSourceFile() &&
                own.pos <= reference.node.pos &&
                reference.node.end <= own.end
            )
        );
        if (used) return [];
        const line =
          file.root.getLineAndCharacterOfPosition(
            declaration.getStart(file.root)
          ).line + 1;
        return [
          {
            file: file.path,
            line,
            rule: "unused-export",
            identity: `${file.path}:${name?.getStart(file.root) ?? declaration.getStart(file.root)}:${displayName}`,
            message: messageFor(
              ctx,
              `Exported symbol ${displayName} has no in-project references`
            ),
          },
        ];
      }
    );
  },
};

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)
  );
}

function localValueDeclarations(
  source: ts.SourceFile
): Array<{ declaration: ts.Declaration; name: ts.Identifier }> {
  const found: Array<{ declaration: ts.Declaration; name: ts.Identifier }> = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name
    )
      found.push({ declaration: node, name: node.name });
    else if (ts.isVariableDeclaration(node))
      for (const name of bindingIdentifiers(node.name))
        found.push({ declaration: node, name });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function referencedSymbolKeys(
  ctx: ProjectContext,
  files: CheckedParsedFile[]
): Set<string> {
  const keys = new Set<string>();
  for (const file of files) {
    const visit = (node: ts.Node) => {
      if (
        ts.isIdentifier(node) &&
        !isInsideImport(node) &&
        isIdentifierRead(node)
      ) {
        const symbol = targetSymbol(file.checker, node);
        const isSelfReference = (symbol?.declarations ?? []).some(
          (declaration) =>
            declaration.getSourceFile() === node.getSourceFile() &&
            declaration.getStart(node.getSourceFile()) <=
              node.getStart(node.getSourceFile()) &&
            node.end <= declaration.end
        );
        if (symbol && !isSelfReference)
          for (const key of symbolDeclarationKeys(ctx, symbol)) keys.add(key);
      }
      ts.forEachChild(node, visit);
    };
    visit(file.root);
  }
  return keys;
}

function deadSymbolIdentityBase(
  file: ParsedFile,
  declaration: ts.Declaration,
  name: ts.Identifier
): string {
  return `${file.path}:${[
    ...structuralScopes(file, declaration, true),
    `${ts.SyntaxKind[declaration.kind]}:${name.text}`,
  ].join("/")}`;
}

const deadSymbols: ProjectRule = {
  kind: "project",
  id: "dead-symbols",
  aliases: ["dead_symbols"],
  description:
    "Unreferenced private functions, classes and variables should not remain in scanned source.",
  defaultLevel: "off",
  check(ctx) {
    const files = checkedProjectFiles(ctx);
    const references = referencedSymbolKeys(ctx, files);
    const candidates = files.flatMap((file) => {
      const exported = exportedSymbols(ctx, file.checker, file.root);
      const unique = new Map<
        string,
        {
          file: CheckedParsedFile;
          declaration: ts.Declaration;
          name: ts.Identifier;
          symbol: ts.Symbol;
        }
      >();
      for (const { declaration, name } of localValueDeclarations(file.root)) {
        const container =
          ts.isVariableDeclaration(declaration) &&
          ts.isVariableDeclarationList(declaration.parent)
            ? declaration.parent.parent
            : declaration;
        const symbol = file.checker.getSymbolAtLocation(name);
        if (!symbol) continue;
        const declarationKeys = symbolDeclarationKeys(ctx, symbol);
        if (
          hasExportModifier(container) ||
          [...declarationKeys].some((key) => exported.has(key)) ||
          (ts.getCombinedModifierFlags(declaration) &
            ts.ModifierFlags.Ambient) !==
            0
        )
          continue;
        const key = [...declarationKeys].sort().join("|");
        if (!key) continue;
        unique.set(key, { file, declaration, name, symbol });
      }
      return [...unique.values()];
    });

    const identityOccurrences = new Map<string, number>();
    const identities = candidates.map((candidate) => {
      const baselineIdentity = deadSymbolIdentityBase(
        candidate.file,
        candidate.declaration,
        candidate.name
      );
      const occurrence = identityOccurrences.get(baselineIdentity) ?? 0;
      identityOccurrences.set(baselineIdentity, occurrence + 1);
      return {
        baselineIdentity,
        identity: `${baselineIdentity}:${occurrence}`,
      };
    });

    return candidates.flatMap((candidate, index) => {
      if (
        [...symbolDeclarationKeys(ctx, candidate.symbol)].some((key) =>
          references.has(key)
        )
      )
        return [];
      const baselineIdentity = deadSymbolIdentityBase(
        candidate.file,
        candidate.declaration,
        candidate.name
      );
      const occurrence = identityOccurrences.get(baselineIdentity) ?? 0;
      identityOccurrences.set(baselineIdentity, occurrence + 1);
      const line =
        candidate.file.root.getLineAndCharacterOfPosition(
          candidate.name.getStart(candidate.file.root)
        ).line + 1;
      const identity = identities[index]!;
      return {
        file: candidate.file.path,
        line,
        rule: "dead-symbols",
        identity: identity.identity,
        baselineIdentity: identity.baselineIdentity,
        message: messageFor(
          ctx,
          `Private symbol ${candidate.name.text} has no in-project references`
        ),
      };
    });
  },
};

const orphanType: ProjectRule = {
  kind: "project",
  id: "orphan-type",
  description:
    "Unreferenced type declarations should not remain in scanned source.",
  defaultLevel: "off",
  check(ctx) {
    const includeExported = option(ctx, "includeExported", false);
    if (typeof includeExported !== "boolean")
      throw new Error("includeExported must be a boolean");
    const files = checkedProjectFiles(ctx);
    const types = files.flatMap(topLevelTypes);
    const exported = new Map(
      files.map((file) => [
        file.path,
        exportedSymbols(ctx, file.checker, file.root),
      ])
    );
    const references = files.flatMap((file) =>
      typeReferenceNodes(file.root).map((node) => ({
        file,
        node,
        symbol: targetSymbol(file.checker, node),
      }))
    );
    return types.flatMap(({ file, node, name }) => {
      const symbol = file.checker.getSymbolAtLocation(name);
      if (!symbol) return [];
      if (
        !includeExported &&
        [...symbolDeclarationKeys(ctx, symbol)].some((key) =>
          exported.get(file.path)?.has(key)
        )
      )
        return [];
      const declarations = symbol.declarations ?? [node];
      const referenced = references.some(
        ({ symbol: referenceSymbol, node: reference }) =>
          referenceSymbol !== undefined &&
          symbolsMatch(ctx, referenceSymbol, symbol) &&
          !declarations.some(
            (declaration) =>
              declaration.getSourceFile() === reference.getSourceFile() &&
              declaration.pos <= reference.pos &&
              reference.end <= declaration.end
          )
      );
      if (referenced) return [];
      const line =
        file.root.getLineAndCharacterOfPosition(node.getStart(file.root)).line +
        1;
      return [
        {
          file: file.path,
          line,
          rule: "orphan-type",
          identity: `${file.path}:${name.getStart(file.root)}:${name.text}`,
          message: messageFor(
            ctx,
            `Type ${name.text} has no references in scanned source`
          ),
        },
      ];
    });
  },
};

function receiverIdentifier(expression: ts.Expression): ts.Identifier | null {
  if (ts.isIdentifier(expression)) return expression;
  if (ts.isPropertyAccessExpression(expression))
    return receiverIdentifier(expression.expression);
  if (ts.isElementAccessExpression(expression))
    return receiverIdentifier(expression.expression);
  return null;
}

function isWriteAccess(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression
): boolean {
  let target: ts.Node = node;
  while (ts.isParenthesizedExpression(target.parent)) target = target.parent;
  const parent = target.parent;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === target &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return true;
  if (ts.isDeleteExpression(parent) && parent.expression === target)
    return true;
  return (
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken) &&
    parent.operand === target
  );
}

function isIdentifierRead(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (
    ts.isPartOfTypeNode(node) ||
    ((ts.isParameter(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isTypeParameterDeclaration(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isEnumMember(parent) ||
      ts.isModuleDeclaration(parent)) &&
      "name" in parent &&
      parent.name === node)
  )
    return false;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) &&
      parent.name === node &&
      !ts.isComputedPropertyName(parent.name))
  )
    return false;
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  )
    return false;
  if (ts.isDeleteExpression(parent) && parent.expression === node) return false;
  return !(
    (ts.isPrefixUnaryExpression(parent) ||
      ts.isPostfixUnaryExpression(parent)) &&
    parent.operand === node &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  );
}

function bindingWritePositions(
  node: ts.Node,
  checker: ts.TypeChecker
): Map<ts.Symbol, number> {
  const assigned = new Map<ts.Symbol, number>();
  const addSymbol = (symbol: ts.Symbol | undefined, position: number) => {
    if (symbol)
      assigned.set(
        symbol,
        Math.min(assigned.get(symbol) ?? Infinity, position)
      );
  };
  const addTarget = (target: ts.Node, position: number) => {
    if (ts.isParenthesizedExpression(target)) {
      addTarget(target.expression, position);
      return;
    }
    if (ts.isIdentifier(target)) {
      addSymbol(checker.getSymbolAtLocation(target), position);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements)
        if (!ts.isOmittedExpression(element))
          addTarget(
            ts.isSpreadElement(element) ? element.expression : element,
            position
          );
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property))
          addSymbol(
            checker.getShorthandAssignmentValueSymbol(property),
            position
          );
        else if (ts.isPropertyAssignment(property))
          addTarget(property.initializer, position);
        else if (ts.isSpreadAssignment(property))
          addTarget(property.expression, position);
      }
    }
  };
  const add = (identifier: ts.Identifier, position: number) => {
    addSymbol(checker.getSymbolAtLocation(identifier), position);
  };
  const visit = (child: ts.Node) => {
    if (child !== node && ts.isFunctionLike(child)) return;
    if (
      ts.isBinaryExpression(child) &&
      child.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      child.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      addTarget(child.left, child.right.getEnd());
    }
    if (
      (ts.isPrefixUnaryExpression(child) ||
        ts.isPostfixUnaryExpression(child)) &&
      (child.operator === ts.SyntaxKind.PlusPlusToken ||
        child.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(child.operand)
    )
      add(child.operand, child.getEnd());
    if (
      (ts.isForOfStatement(child) || ts.isForInStatement(child)) &&
      !ts.isVariableDeclarationList(child.initializer)
    )
      addTarget(child.initializer, child.expression.getEnd());
    ts.forEachChild(child, visit);
  };
  visit(node);
  return assigned;
}

const featureEnvy: ProjectRule = {
  kind: "project",
  id: "feature-envy",
  description:
    "Class methods should not read far more properties from a parameter than from their own instance.",
  defaultLevel: "off",
  check(ctx) {
    const minimumExternalAccesses = positiveInteger(
      option(ctx, "minimumExternalAccesses", 4),
      "minimumExternalAccesses"
    );
    const minimumRatio = positiveInteger(
      option(ctx, "minimumRatio", 2),
      "minimumRatio"
    );
    return checkedProjectFiles(ctx).flatMap((file) => {
      const findings: Violation[] = [];
      const { checker } = file;
      const visitClass = (node: ts.Node) => {
        if (ts.isClassLike(node))
          for (const member of node.members)
            if (
              ts.isMethodDeclaration(member) &&
              member.body &&
              member.parameters.length > 0
            ) {
              const receivers = new Map<ts.Symbol, string>();
              const trackedBindings = new Map<
                ts.Symbol,
                { receiver: string; validBefore: number }
              >();
              const writes = bindingWritePositions(member.body, checker);
              for (const parameter of member.parameters)
                if (ts.isIdentifier(parameter.name)) {
                  const symbol = checker.getSymbolAtLocation(parameter.name);
                  if (symbol) receivers.set(symbol, parameter.name.text);
                }
              const trackBinding = (
                identifier: ts.Identifier,
                source: string
              ) => {
                const symbol = checker.getSymbolAtLocation(identifier);
                if (symbol)
                  trackedBindings.set(symbol, {
                    receiver: source,
                    validBefore: writes.get(symbol) ?? Infinity,
                  });
              };
              member.parameters.forEach((parameter, index) => {
                if (ts.isObjectBindingPattern(parameter.name))
                  for (const identifier of bindingIdentifiers(parameter.name))
                    trackBinding(
                      identifier,
                      `destructured parameter ${index + 1}`
                    );
              });
              const aliases: {
                source: ts.Symbol;
                targets: ts.Identifier[];
                destructured: boolean;
                declarationPosition: number;
              }[] = [];
              const collectAliases = (child: ts.Node) => {
                if (child !== member.body && ts.isFunctionLike(child)) return;
                if (
                  ts.isVariableDeclaration(child) &&
                  child.initializer &&
                  ts.isIdentifier(child.initializer)
                ) {
                  const symbol = checker.getSymbolAtLocation(child.initializer);
                  if (symbol && ts.isIdentifier(child.name))
                    aliases.push({
                      source: symbol,
                      targets: [child.name],
                      destructured: false,
                      declarationPosition: child.getStart(),
                    });
                  else if (symbol && ts.isObjectBindingPattern(child.name))
                    aliases.push({
                      source: symbol,
                      targets: bindingIdentifiers(child.name),
                      destructured: true,
                      declarationPosition: child.getStart(),
                    });
                }
                ts.forEachChild(child, collectAliases);
              };
              collectAliases(member.body);
              let aliasesChanged = true;
              while (aliasesChanged) {
                aliasesChanged = false;
                for (const alias of aliases) {
                  const sourceReceiver = receivers.get(alias.source);
                  const sourceBinding = trackedBindings.get(alias.source);
                  const receiver = sourceReceiver ?? sourceBinding?.receiver;
                  const sourceWrite = writes.get(alias.source) ?? Infinity;
                  if (
                    !receiver ||
                    alias.declarationPosition >= sourceWrite ||
                    (sourceBinding &&
                      alias.declarationPosition >= sourceBinding.validBefore)
                  )
                    continue;
                  for (const target of alias.targets) {
                    const symbol = checker.getSymbolAtLocation(target);
                    if (!symbol) continue;
                    const binding = {
                      receiver,
                      validBefore: writes.get(symbol) ?? Infinity,
                    };
                    if (alias.destructured) {
                      if (!trackedBindings.has(symbol)) {
                        trackedBindings.set(symbol, binding);
                        aliasesChanged = true;
                      }
                    } else if (!receivers.has(symbol)) {
                      receivers.set(symbol, receiver);
                      aliasesChanged = true;
                    }
                  }
                }
              }
              const external = new Map<string, number>();
              let own = 0;
              const visitBody = (child: ts.Node) => {
                if (child !== member.body && ts.isFunctionLike(child)) return;
                if (
                  (ts.isPropertyAccessExpression(child) ||
                    ts.isElementAccessExpression(child)) &&
                  !isWriteAccess(child)
                ) {
                  if (child.expression.kind === ts.SyntaxKind.ThisKeyword) {
                    own++;
                  } else {
                    const identifier = receiverIdentifier(child.expression);
                    const symbol = identifier
                      ? checker.getSymbolAtLocation(identifier)
                      : undefined;
                    const receiver = symbol ? receivers.get(symbol) : undefined;
                    const position = child.getStart();
                    if (
                      receiver &&
                      position < (writes.get(symbol!) ?? Infinity)
                    )
                      external.set(receiver, (external.get(receiver) ?? 0) + 1);
                  }
                }
                if (ts.isIdentifier(child) && isIdentifierRead(child)) {
                  const symbol = checker.getSymbolAtLocation(child);
                  const binding = symbol
                    ? trackedBindings.get(symbol)
                    : undefined;
                  if (binding && child.getStart() < binding.validBefore)
                    external.set(
                      binding.receiver,
                      (external.get(binding.receiver) ?? 0) + 1
                    );
                }
                ts.forEachChild(child, visitBody);
              };
              visitBody(member.body);
              const [receiver, accesses] =
                [...external.entries()].sort(
                  (left, right) =>
                    right[1] - left[1] || left[0].localeCompare(right[0])
                )[0] ?? [];
              if (
                !receiver ||
                accesses! < minimumExternalAccesses ||
                accesses! < Math.max(own, 1) * minimumRatio
              )
                continue;
              const line =
                file.root.getLineAndCharacterOfPosition(
                  member.getStart(file.root)
                ).line + 1;
              const sourceName = receiver!.startsWith("destructured parameter ")
                ? receiver
                : `parameter ${receiver}`;
              findings.push({
                file: file.path,
                line,
                rule: "feature-envy",
                identity: structuralIdentity(file, member),
                metrics: {
                  externalAccesses: {
                    value: accesses!,
                    worsening: "higher",
                  },
                },
                message: messageFor(
                  ctx,
                  `${functionName(member)} reads ${accesses} properties from ${sourceName} and ${own} from this`
                ),
              });
            }
        ts.forEachChild(node, visitClass);
      };
      visitClass(file.root);
      return findings;
    });
  },
};

const barrelAbuse: ProjectRule = {
  kind: "project",
  id: "barrel-abuse",
  description:
    "Barrel files must stay below the configured number of re-exported modules.",
  defaultLevel: "off",
  check(ctx) {
    const maximum = positiveInteger(
      option(ctx, "maxReExports", 10),
      "maxReExports"
    );
    return projectSources(ctx).flatMap((file) => {
      const statements = file.root.statements.filter(
        (statement) =>
          !ts.isEmptyStatement(statement) &&
          !(
            ts.isExpressionStatement(statement) &&
            ts.isStringLiteral(statement.expression)
          )
      );
      const reExports = statements.filter(
        (statement) =>
          ts.isExportDeclaration(statement) &&
          statement.moduleSpecifier !== undefined
      );
      if (reExports.length !== statements.length || reExports.length <= maximum)
        return [];
      const line =
        file.root.getLineAndCharacterOfPosition(
          reExports[maximum]!.getStart(file.root)
        ).line + 1;
      return [
        {
          file: file.path,
          line,
          rule: "barrel-abuse",
          identity: `barrel-abuse:${file.path}`,
          metrics: {
            reExports: { value: reExports.length, worsening: "higher" },
          },
          message: `${file.path} re-exports ${reExports.length} modules, above the limit of ${maximum}`,
        },
      ];
    });
  },
};

const sharedMutableState: ProjectRule = {
  kind: "project",
  id: "shared-mutable-state",
  description:
    "Modules must not export mutable bindings or unfrozen object state.",
  defaultLevel: "off",
  check(ctx) {
    return projectSources(ctx).flatMap((file) => {
      const mutableBindings = new Map<string, ts.VariableDeclaration>();
      const exportedNames = new Set<string>();
      const declarations = file.root.statements.filter(ts.isVariableStatement);
      for (const statement of declarations) {
        const isConst =
          (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const declaration of statement.declarationList.declarations) {
          const mutableNames = mutableBindingNames(
            declaration.name,
            declaration.initializer,
            !isConst
          );
          for (const name of mutableNames)
            mutableBindings.set(name, declaration);
          if (hasExportModifier(statement))
            for (const name of bindingNames(declaration.name))
              exportedNames.add(name);
        }
      }
      for (const statement of file.root.statements) {
        if (
          !ts.isExportDeclaration(statement) ||
          statement.moduleSpecifier ||
          statement.isTypeOnly ||
          !statement.exportClause ||
          !ts.isNamedExports(statement.exportClause)
        )
          continue;
        for (const specifier of statement.exportClause.elements)
          if (!specifier.isTypeOnly)
            exportedNames.add(
              specifier.propertyName?.text ?? specifier.name.text
            );
      }
      const findings: Violation[] = [];
      const emitted = new Set<string>();
      for (const name of exportedNames) {
        const declaration = mutableBindings.get(name);
        if (!declaration) continue;
        const line =
          file.root.getLineAndCharacterOfPosition(
            declaration.getStart(file.root)
          ).line + 1;
        const identity = `${file.path}:${declaration.getStart(file.root)}:${name}`;
        emitted.add(identity);
        findings.push({
          file: file.path,
          line,
          rule: "shared-mutable-state",
          identity,
          message: `Exported binding ${name} may expose shared mutable state`,
        });
      }
      for (const statement of file.root.statements) {
        if (
          !ts.isExportAssignment(statement) ||
          statement.isExportEquals ||
          !(ts.isIdentifier(statement.expression)
            ? mutableBindings.has(statement.expression.text)
            : isMutableStateInitializer(statement.expression))
        )
          continue;
        const line =
          file.root.getLineAndCharacterOfPosition(statement.getStart(file.root))
            .line + 1;
        const identity = `${file.path}:${statement.getStart(file.root)}:default`;
        if (emitted.has(identity)) continue;
        findings.push({
          file: file.path,
          line,
          rule: "shared-mutable-state",
          identity,
          message: "Default export may expose shared mutable state",
        });
      }
      return findings;
    });
  },
};

export const RULES: ProjectRule[] = [
  abstractness,
  dependencyInversion,
  cyclomaticComplexity,
  cognitiveComplexityRule,
  longParameterList,
  deepNesting,
  largeFunction,
  largeFile,
  godModule,
  interfaceSegregation,
  moduleCohesion,
  primitiveObsession,
  scatteredConfig,
  unstableInterface,
  unusedExport,
  deadSymbols,
  orphanType,
  featureEnvy,
  barrelAbuse,
  sharedMutableState,
];
