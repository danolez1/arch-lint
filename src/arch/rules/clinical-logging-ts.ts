import { createHash } from "node:crypto";
import ts from "typescript";
import { matchesAny } from "../paths";
import type { Violation } from "../types";
import type { FileScope, Settings } from "./clinical-logging-settings";
import { violation } from "./util";

// Settings of the check in progress; the analysis is synchronous so one slot is enough.
let S: Settings;

function isLoggerModule(source: string | undefined): boolean {
  return (
    source !== undefined &&
    S.loggerModule !== null &&
    S.loggerModule.test(source)
  );
}

function isCorePackage(source: string | undefined): boolean {
  return (
    source !== undefined && S.corePackage !== "" && source === S.corePackage
  );
}

const LOGGER_METHODS = new Set(["debug", "error", "info", "warn"]);
const RAW_CONSOLE_METHODS = new Set([
  "debug",
  "debuglog",
  "error",
  "info",
  "log",
  "trace",
  "warn",
  "writeSync",
]);
const RAW_PROCESS_METHODS = new Set(["_rawDebug", "emitWarning", "write"]);
const RAW_FILE_SYSTEM_METHODS = new Set([
  "appendFile",
  "appendFileSync",
  "createWriteStream",
  "write",
  "writeFile",
  "writeFileSync",
  "writeSync",
  "writev",
  "writevSync",
]);
const RAW_CAPABILITY_MODULES = new Set([
  "console",
  "fs",
  "node:console",
  "node:fs",
  "node:fs/promises",
  "node:process",
  "node:util",
  "process",
  "fs/promises",
  "util",
]);
const CORE_LOGGER_SOURCE_APPROVAL = new WeakMap<ts.SourceFile, boolean>();
const SOURCE_SHA256 = new WeakMap<ts.SourceFile, string>();

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.CommaToken
    ) {
      current = current.right;
      continue;
    }
    return current;
  }
}

function memberName(expression: ts.Expression): string | undefined {
  const value = unwrap(expression);
  if (ts.isPropertyAccessExpression(value)) return value.name.text;
  if (ts.isElementAccessExpression(value))
    return staticStringValue(value.argumentExpression);
  return undefined;
}

function staticStringValue(
  expression: ts.Expression | undefined
): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
    return value.text;
  if (
    !ts.isBinaryExpression(value) ||
    value.operatorToken.kind !== ts.SyntaxKind.PlusToken
  ) {
    return undefined;
  }
  const left = staticStringValue(value.left);
  const right = staticStringValue(value.right);
  return left === undefined || right === undefined
    ? undefined
    : `${left}${right}`;
}

function memberOwner(expression: ts.Expression): ts.Expression | undefined {
  const value = unwrap(expression);
  if (
    ts.isPropertyAccessExpression(value) ||
    ts.isElementAccessExpression(value)
  ) {
    return unwrap(value.expression);
  }
  return undefined;
}

function identifierName(
  expression: ts.Expression | undefined
): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isIdentifier(value) ? value.text : undefined;
}

function declarationListBindsName(
  list: ts.VariableDeclarationList,
  name: string
): boolean {
  return list.declarations.some((declaration) =>
    bindingIdentifiers(declaration.name).some(
      (identifier) => identifier.text === name
    )
  );
}

function statementBindsName(statement: ts.Statement, name: string): boolean {
  if (ts.isVariableStatement(statement)) {
    return declarationListBindsName(statement.declarationList, name);
  }
  if (
    (ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name?.text === name
  ) {
    return true;
  }
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    if (clause?.name?.text === name) return true;
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      return bindings.name.text === name;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some((element) => element.name.text === name)
    );
  }
  return (
    ts.isImportEqualsDeclaration(statement) && statement.name.text === name
  );
}

function hasLexicalShadowing(node: ts.Node, name: string): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionLike(current) &&
      current.parameters.some((parameter) =>
        bindingIdentifiers(parameter.name).some(
          (identifier) => identifier.text === name
        )
      )
    ) {
      return true;
    }
    if (
      (ts.isSourceFile(current) ||
        ts.isBlock(current) ||
        ts.isModuleBlock(current)) &&
      current.statements.some((statement) =>
        statementBindsName(statement, name)
      )
    ) {
      return true;
    }
    if (
      ts.isCatchClause(current) &&
      current.variableDeclaration &&
      bindingIdentifiers(current.variableDeclaration.name).some(
        (identifier) => identifier.text === name
      )
    ) {
      return true;
    }
    if (
      ts.isForStatement(current) &&
      current.initializer &&
      ts.isVariableDeclarationList(current.initializer) &&
      declarationListBindsName(current.initializer, name)
    ) {
      return true;
    }
    if (
      (ts.isForInStatement(current) || ts.isForOfStatement(current)) &&
      ts.isVariableDeclarationList(current.initializer) &&
      declarationListBindsName(current.initializer, name)
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function isNativeGlobalIdentifier(
  expression: ts.Expression | undefined,
  name: string
): boolean {
  const value = expression && unwrap(expression);
  return Boolean(
    value &&
    ts.isIdentifier(value) &&
    value.text === name &&
    !hasLexicalShadowing(value, name)
  );
}

function rootIdentifierName(expression: ts.Expression): string | undefined {
  let current = unwrap(expression);
  while (
    ts.isPropertyAccessExpression(current) ||
    ts.isElementAccessExpression(current)
  ) {
    current = unwrap(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : undefined;
}

function isIdentifierDeclarationName(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isBindingElement(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isImportClause(parent) ||
      ts.isImportSpecifier(parent) ||
      ts.isImportEqualsDeclaration(parent) ||
      ts.isNamespaceImport(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyAccessExpression(parent)) &&
    parent.name === node
  ) {
    return true;
  }
  return false;
}

function isInsideTypePosition(node: ts.Node): boolean {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isStatement(current) && !ts.isSourceFile(current)) {
    if (ts.isTypeNode(current)) return true;
    current = current.parent;
  }
  return false;
}

function isCoreLoggerPublicExport(file: string, node: ts.Node): boolean {
  if (
    S.coreIndexFile === "" ||
    file !== S.coreIndexFile ||
    !ts.isIdentifier(node)
  )
    return false;
  const specifier = ts.isExportSpecifier(node.parent) ? node.parent : undefined;
  const declaration = specifier?.parent.parent;
  if (!specifier || !declaration || !ts.isExportDeclaration(declaration))
    return false;
  if (
    !declaration.moduleSpecifier ||
    !ts.isStringLiteral(declaration.moduleSpecifier)
  )
    return false;
  const exportedName = specifier.propertyName?.text ?? specifier.name.text;
  return (
    declaration.moduleSpecifier.text === S.coreIndexSpecifier &&
    (exportedName === S.createLoggerName ||
      exportedName === S.redactedWriterName)
  );
}

function isStaticString(
  expression: ts.Expression | undefined
): expression is ts.StringLiteralLike {
  if (!expression) return false;
  const value = unwrap(expression);
  return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value);
}

function importsRuntimeModuleFactory(node: ts.ImportDeclaration): boolean {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return false;
  if (
    node.moduleSpecifier.text !== "node:module" &&
    node.moduleSpecifier.text !== "module"
  ) {
    return false;
  }
  const clause = node.importClause;
  if (!clause) return false;
  if (
    clause.name ||
    (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
  ) {
    return true;
  }
  const bindings = clause.namedBindings;
  return (
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.some(
      (specifier) =>
        (specifier.propertyName?.text ?? specifier.name.text) ===
        "createRequire"
    )
  );
}

function exportsLoggerCapability(node: ts.ExportDeclaration): boolean {
  if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier))
    return false;
  const source = node.moduleSpecifier.text;
  if (isLoggerModule(source)) return true;
  if (!isCorePackage(source)) return false;
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return true;
  return node.exportClause.elements.some((specifier) => {
    const name = specifier.propertyName?.text ?? specifier.name.text;
    return name === S.createLoggerName || name === S.redactedWriterName;
  });
}

function isModuleLoadCall(
  expression: ts.Expression
): expression is ts.CallExpression {
  const value = unwrap(expression);
  if (!ts.isCallExpression(value)) return false;
  const target = unwrap(value.expression);
  return (
    target.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(target) &&
      target.text === "require" &&
      !hasLexicalShadowing(target, "require"))
  );
}

function loadedModuleName(expression: ts.Expression): string | undefined {
  const value = unwrap(expression);
  if (!isModuleLoadCall(value) || value.arguments.length !== 1)
    return undefined;
  return isStaticString(value.arguments[0])
    ? value.arguments[0].text
    : undefined;
}

function reflectedGlobalCapability(
  expression: ts.Expression,
  reflectObjects: ReadonlySet<string>,
  reflectGetFunctions: ReadonlySet<string> = new Set()
): string | undefined {
  const value = unwrap(expression);
  if (!ts.isCallExpression(value) || value.arguments.length < 2)
    return undefined;
  const target = unwrap(value.expression);
  if (
    !isReflectGetExpression(target, reflectGetFunctions, reflectObjects) ||
    !isNativeGlobalIdentifier(value.arguments[0], "globalThis")
  ) {
    return undefined;
  }
  return staticStringValue(value.arguments[1]) ?? "*";
}

function isCoreNamespaceExpression(
  expression: ts.Expression,
  coreNamespaces: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  return (
    (ts.isIdentifier(value) && coreNamespaces.has(value.text)) ||
    isCorePackage(loadedModuleName(value))
  );
}

function isClinicalTextName(name: string): boolean {
  return S.clinicalTextName.test(name.replace(/[^a-z0-9]/gi, "").toLowerCase());
}

function callableTarget(expression: ts.Expression): ts.Expression {
  const value = unwrap(expression);
  if (ts.isCallExpression(value) && memberName(value.expression) === "bind") {
    return callableTarget(memberOwner(value.expression) ?? value.expression);
  }
  const invocation = memberName(value);
  if (invocation === "call" || invocation === "apply") {
    return callableTarget(memberOwner(value) ?? value);
  }
  return value;
}

function expressionCarriesClinicalText(
  node: ts.Node,
  tainted: ReadonlySet<string>
): boolean {
  if (ts.isIdentifier(node))
    return tainted.has(node.text) || isClinicalTextName(node.text);
  if (ts.isPropertyAccessExpression(node)) {
    if (node.name.text === "length" || node.name.text === "byteLength")
      return false;
    return (
      isClinicalTextName(node.name.text) ||
      expressionCarriesClinicalText(node.expression, tainted)
    );
  }
  if (ts.isElementAccessExpression(node)) {
    if (
      node.argumentExpression &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNoSubstitutionTemplateLiteral(node.argumentExpression)) &&
      isClinicalTextName(node.argumentExpression.text)
    ) {
      return true;
    }
    return expressionCarriesClinicalText(node.expression, tainted);
  }

  let carries = false;
  node.forEachChild((child) => {
    if (!carries) carries = expressionCarriesClinicalText(child, tainted);
  });
  return carries;
}

function loggerMethod(
  expression: ts.Expression,
  loggerObjects: ReadonlySet<string>,
  loggerContainers: ReadonlySet<string>,
  loggerMethods: ReadonlyMap<string, string>
): string | undefined {
  const value = callableTarget(expression);
  if (ts.isConditionalExpression(value)) {
    return (
      loggerMethod(
        value.whenTrue,
        loggerObjects,
        loggerContainers,
        loggerMethods
      ) ??
      loggerMethod(
        value.whenFalse,
        loggerObjects,
        loggerContainers,
        loggerMethods
      )
    );
  }
  if (ts.isIdentifier(value)) return loggerMethods.get(value.text);
  const method = memberName(value);
  const owner = memberOwner(value);
  if (
    ts.isElementAccessExpression(value) &&
    owner &&
    isLoggerObjectExpression(owner, loggerObjects, loggerContainers)
  ) {
    return method ?? "dynamic";
  }
  return method &&
    LOGGER_METHODS.has(method) &&
    owner &&
    isLoggerObjectExpression(owner, loggerObjects, loggerContainers)
    ? method
    : undefined;
}

function isLoggerObjectExpression(
  expression: ts.Expression,
  loggerObjects: ReadonlySet<string>,
  loggerContainers: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return loggerObjects.has(value.text);
  if (ts.isConditionalExpression(value)) {
    return (
      isLoggerObjectExpression(
        value.whenTrue,
        loggerObjects,
        loggerContainers
      ) ||
      isLoggerObjectExpression(value.whenFalse, loggerObjects, loggerContainers)
    );
  }
  const owner = memberOwner(value);
  return (
    owner !== undefined && isLoggerContainerExpression(owner, loggerContainers)
  );
}

function isLoggerContainerExpression(
  expression: ts.Expression,
  loggerContainers: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return loggerContainers.has(value.text);
  const owner = memberOwner(value);
  return (
    owner !== undefined && isLoggerContainerExpression(owner, loggerContainers)
  );
}

function literalContainsLogger(
  expression: ts.Expression,
  loggerObjects: ReadonlySet<string>,
  loggerContainers: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isSpreadElement(value)) {
    return (
      isLoggerObjectExpression(
        value.expression,
        loggerObjects,
        loggerContainers
      ) ||
      literalContainsLogger(value.expression, loggerObjects, loggerContainers)
    );
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) =>
        ts.isExpression(element) &&
        (isLoggerObjectExpression(element, loggerObjects, loggerContainers) ||
          literalContainsLogger(element, loggerObjects, loggerContainers))
    );
  }
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return isLoggerObjectExpression(
        property.name,
        loggerObjects,
        loggerContainers
      );
    }
    if (ts.isPropertyAssignment(property) || ts.isSpreadAssignment(property)) {
      const expression = ts.isPropertyAssignment(property)
        ? property.initializer
        : property.expression;
      return (
        isLoggerObjectExpression(expression, loggerObjects, loggerContainers) ||
        literalContainsLogger(expression, loggerObjects, loggerContainers)
      );
    }
    return false;
  });
}

function importDeclaration(node: ts.Node): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name)
  );
}

function bindingPropertyName(
  element: ts.BindingElement,
  sourceFile: ts.SourceFile
): string {
  return (
    element.propertyName?.getText(sourceFile) ??
    element.name.getText(sourceFile)
  );
}

function collectAliases(sourceFile: ts.SourceFile): {
  bunObjects: Set<string>;
  consoleObjects: Set<string>;
  coreNamespaces: Set<string>;
  createLoggerFunctions: Set<string>;
  environmentObjects: Set<string>;
  loggerContainers: Set<string>;
  loggerObjects: Set<string>;
  loggerMethods: Map<string, string>;
  outputStreams: Set<string>;
  processObjects: Set<string>;
  rawSinkContainers: Set<string>;
  rawSinkFunctions: Set<string>;
  redactedWriterFunctions: Set<string>;
  reflectApplyFunctions: Set<string>;
  reflectGetFunctions: Set<string>;
  reflectObjects: Set<string>;
  tainted: Set<string>;
} {
  const bunObjects = new Set(["Bun"]);
  const consoleObjects = new Set(["console"]);
  const coreNamespaces = new Set<string>();
  const createLoggerFunctions = new Set<string>();
  const environmentObjects = new Set<string>();
  const loggerContainers = new Set<string>();
  const loggerObjects = new Set<string>();
  const loggerMethods = new Map<string, string>();
  const outputStreams = new Set<string>();
  const processObjects = new Set(["process", "Bun"]);
  const rawSinkContainers = new Set<string>();
  const rawSinkFunctions = new Set<string>();
  const redactedWriterFunctions = new Set<string>();
  const reflectApplyFunctions = new Set<string>();
  const reflectGetFunctions = new Set<string>();
  const reflectObjects = new Set(["Reflect"]);
  const tainted = new Set<string>();

  const visitImports = (node: ts.Node) => {
    const declaration = importDeclaration(node);
    const source =
      declaration && ts.isStringLiteral(declaration.moduleSpecifier)
        ? declaration.moduleSpecifier.text
        : undefined;
    if (ts.isImportSpecifier(node)) {
      const importedName = node.propertyName?.text ?? node.name.text;
      if (isLoggerModule(source)) {
        loggerObjects.add(node.name.text);
      }
      if (isCorePackage(source) && importedName === S.createLoggerName) {
        createLoggerFunctions.add(node.name.text);
      }
      if (isCorePackage(source) && importedName === S.redactedWriterName) {
        redactedWriterFunctions.add(node.name.text);
      }
      if (source === "node:process" || source === "process") {
        if (importedName === "stdout" || importedName === "stderr") {
          outputStreams.add(node.name.text);
        }
        if (importedName === "env") environmentObjects.add(node.name.text);
      }
      if (source === "node:console" || source === "console") {
        if (RAW_CONSOLE_METHODS.has(importedName))
          rawSinkFunctions.add(node.name.text);
      }
      if (
        (source === "node:util" || source === "util") &&
        importedName === "debuglog"
      ) {
        rawSinkFunctions.add(node.name.text);
      }
      if (
        (source === "node:fs" ||
          source === "fs" ||
          source === "node:fs/promises" ||
          source === "fs/promises") &&
        RAW_FILE_SYSTEM_METHODS.has(importedName)
      ) {
        rawSinkFunctions.add(node.name.text);
      }
    }
    if (ts.isNamespaceImport(node)) {
      if (isCorePackage(source)) coreNamespaces.add(node.name.text);
      if (isLoggerModule(source)) loggerContainers.add(node.name.text);
      if (source === "node:process" || source === "process")
        processObjects.add(node.name.text);
      if (
        source === "node:console" ||
        source === "console" ||
        source === "node:util" ||
        source === "util" ||
        source === "node:fs" ||
        source === "fs" ||
        source === "node:fs/promises" ||
        source === "fs/promises"
      ) {
        consoleObjects.add(node.name.text);
      }
    }
    if (ts.isImportClause(node) && node.name) {
      if (isLoggerModule(source)) loggerObjects.add(node.name.text);
      if (source === "node:process" || source === "process")
        processObjects.add(node.name.text);
      if (
        source === "node:console" ||
        source === "console" ||
        source === "node:util" ||
        source === "util" ||
        source === "node:fs" ||
        source === "fs" ||
        source === "node:fs/promises" ||
        source === "fs/promises"
      ) {
        consoleObjects.add(node.name.text);
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const moduleName = node.moduleReference.expression;
      if (moduleName && ts.isStringLiteral(moduleName)) {
        if (
          moduleName.text === "node:process" ||
          moduleName.text === "process"
        ) {
          processObjects.add(node.name.text);
        }
        if (
          moduleName.text === "node:console" ||
          moduleName.text === "console" ||
          moduleName.text === "node:util" ||
          moduleName.text === "util" ||
          moduleName.text === "node:fs" ||
          moduleName.text === "fs" ||
          moduleName.text === "node:fs/promises" ||
          moduleName.text === "fs/promises"
        ) {
          consoleObjects.add(node.name.text);
        }
      }
    }
    node.forEachChild(visitImports);
  };
  visitImports(sourceFile);

  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrap(node.initializer);
        if (ts.isIdentifier(node.name)) {
          const moduleName = loadedModuleName(initializer);
          if (
            (moduleName === "node:process" || moduleName === "process") &&
            !processObjects.has(node.name.text)
          ) {
            processObjects.add(node.name.text);
            changed = true;
          }
          if (
            (moduleName === "node:console" ||
              moduleName === "console" ||
              moduleName === "node:fs" ||
              moduleName === "fs" ||
              moduleName === "node:fs/promises" ||
              moduleName === "fs/promises") &&
            !consoleObjects.has(node.name.text)
          ) {
            consoleObjects.add(node.name.text);
            changed = true;
          }
          if (
            isCorePackage(moduleName) &&
            !coreNamespaces.has(node.name.text)
          ) {
            coreNamespaces.add(node.name.text);
            changed = true;
          }
          if (
            isBunObjectExpression(initializer, bunObjects) &&
            !bunObjects.has(node.name.text)
          ) {
            bunObjects.add(node.name.text);
            changed = true;
          }
          if (
            isProcessObjectExpression(initializer, processObjects) &&
            !processObjects.has(node.name.text)
          ) {
            processObjects.add(node.name.text);
            changed = true;
          }
          if (
            isReflectObjectExpression(initializer, reflectObjects) &&
            !reflectObjects.has(node.name.text)
          ) {
            reflectObjects.add(node.name.text);
            changed = true;
          }
          if (
            isReflectApplyExpression(
              initializer,
              reflectApplyFunctions,
              reflectObjects
            ) &&
            !reflectApplyFunctions.has(node.name.text)
          ) {
            reflectApplyFunctions.add(node.name.text);
            changed = true;
          }
          if (
            isReflectGetExpression(
              initializer,
              reflectGetFunctions,
              reflectObjects
            ) &&
            !reflectGetFunctions.has(node.name.text)
          ) {
            reflectGetFunctions.add(node.name.text);
            changed = true;
          }
          if (
            isCoreNamespaceExpression(initializer, coreNamespaces) &&
            !coreNamespaces.has(node.name.text)
          ) {
            coreNamespaces.add(node.name.text);
            changed = true;
          }
          if (isConsoleObjectExpression(initializer, consoleObjects)) {
            if (!consoleObjects.has(node.name.text)) {
              consoleObjects.add(node.name.text);
              changed = true;
            }
          }
          if (
            isLoggerObjectExpression(
              initializer,
              loggerObjects,
              loggerContainers
            )
          ) {
            if (!loggerObjects.has(node.name.text)) {
              loggerObjects.add(node.name.text);
              changed = true;
            }
          }
          if (
            ts.isCallExpression(initializer) &&
            isCreateLoggerExpression(
              initializer.expression,
              createLoggerFunctions,
              coreNamespaces
            ) &&
            !loggerObjects.has(node.name.text)
          ) {
            loggerObjects.add(node.name.text);
            changed = true;
          }
          if (
            literalContainsLogger(
              initializer,
              loggerObjects,
              loggerContainers
            ) &&
            !loggerContainers.has(node.name.text)
          ) {
            loggerContainers.add(node.name.text);
            changed = true;
          }
          if (
            isLoggerContainerExpression(initializer, loggerContainers) &&
            !loggerContainers.has(node.name.text)
          ) {
            loggerContainers.add(node.name.text);
            changed = true;
          }
          if (
            literalContainsRawSink(
              initializer,
              consoleObjects,
              outputStreams,
              processObjects,
              rawSinkFunctions,
              rawSinkContainers
            ) &&
            !rawSinkContainers.has(node.name.text)
          ) {
            rawSinkContainers.add(node.name.text);
            changed = true;
          }
          const method = loggerMethod(
            initializer,
            loggerObjects,
            loggerContainers,
            loggerMethods
          );
          if (method && loggerMethods.get(node.name.text) !== method) {
            loggerMethods.set(node.name.text, method);
            changed = true;
          }
          if (
            isOutputStreamExpression(initializer, outputStreams, processObjects)
          ) {
            if (!outputStreams.has(node.name.text)) {
              outputStreams.add(node.name.text);
              changed = true;
            }
          }
          if (
            isEnvironmentObject(
              initializer,
              environmentObjects,
              processObjects,
              bunObjects,
              reflectGetFunctions
            ) &&
            !environmentObjects.has(node.name.text)
          ) {
            environmentObjects.add(node.name.text);
            changed = true;
          }
          if (
            isRawOutputExpression(
              initializer,
              consoleObjects,
              outputStreams,
              processObjects,
              rawSinkFunctions,
              rawSinkContainers
            ) &&
            !rawSinkFunctions.has(node.name.text)
          ) {
            rawSinkFunctions.add(node.name.text);
            changed = true;
          }
          if (
            isCreateLoggerExpression(
              initializer,
              createLoggerFunctions,
              coreNamespaces
            ) &&
            !createLoggerFunctions.has(node.name.text)
          ) {
            createLoggerFunctions.add(node.name.text);
            changed = true;
          }
          if (
            isCoreFunctionExpression(
              initializer,
              S.redactedWriterName,
              redactedWriterFunctions,
              coreNamespaces
            ) &&
            !redactedWriterFunctions.has(node.name.text)
          ) {
            redactedWriterFunctions.add(node.name.text);
            changed = true;
          }
          if (
            !tainted.has(node.name.text) &&
            expressionCarriesClinicalText(initializer, tainted)
          ) {
            tainted.add(node.name.text);
            changed = true;
          }
        } else if (ts.isObjectBindingPattern(node.name)) {
          if (isLoggerContainerExpression(initializer, loggerContainers)) {
            for (const identifier of bindingIdentifiers(node.name)) {
              if (!loggerObjects.has(identifier.text)) {
                loggerObjects.add(identifier.text);
                changed = true;
              }
              if (!loggerContainers.has(identifier.text)) {
                loggerContainers.add(identifier.text);
                changed = true;
              }
            }
          }
          if (
            isLoggerObjectExpression(
              initializer,
              loggerObjects,
              loggerContainers
            )
          ) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const method = bindingPropertyName(element, sourceFile);
              const dynamic = Boolean(
                element.propertyName &&
                ts.isComputedPropertyName(element.propertyName)
              );
              if (
                (dynamic || LOGGER_METHODS.has(method)) &&
                loggerMethods.get(element.name.text) !== method
              ) {
                loggerMethods.set(
                  element.name.text,
                  dynamic ? "dynamic" : method
                );
                changed = true;
              }
            }
          }
          if (isRawSinkContainerExpression(initializer, rawSinkContainers)) {
            for (const identifier of bindingIdentifiers(node.name)) {
              if (!rawSinkFunctions.has(identifier.text)) {
                rawSinkFunctions.add(identifier.text);
                changed = true;
              }
            }
          }
          if (isConsoleObjectExpression(initializer, consoleObjects)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const method = bindingPropertyName(element, sourceFile);
              const dynamic = Boolean(
                element.propertyName &&
                ts.isComputedPropertyName(element.propertyName)
              );
              if (
                (dynamic || RAW_CONSOLE_METHODS.has(method)) &&
                !rawSinkFunctions.has(element.name.text)
              ) {
                rawSinkFunctions.add(element.name.text);
                changed = true;
              }
            }
          }
          if (
            isOutputStreamExpression(initializer, outputStreams, processObjects)
          ) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const method = bindingPropertyName(element, sourceFile);
              const dynamic = Boolean(
                element.propertyName &&
                ts.isComputedPropertyName(element.propertyName)
              );
              if (
                (dynamic || method === "write") &&
                !rawSinkFunctions.has(element.name.text)
              ) {
                rawSinkFunctions.add(element.name.text);
                changed = true;
              }
            }
          }
          if (isProcessObjectExpression(initializer, processObjects)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const property = bindingPropertyName(element, sourceFile);
              const dynamic = Boolean(
                element.propertyName &&
                ts.isComputedPropertyName(element.propertyName)
              );
              if (
                (dynamic || property === "stdout" || property === "stderr") &&
                !outputStreams.has(element.name.text)
              ) {
                outputStreams.add(element.name.text);
                changed = true;
              }
              if (
                (dynamic || property === "env") &&
                !environmentObjects.has(element.name.text)
              ) {
                environmentObjects.add(element.name.text);
                changed = true;
              }
            }
          }
          if (isBunObjectExpression(initializer, bunObjects)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const property = bindingPropertyName(element, sourceFile);
              if (
                property === "env" &&
                !environmentObjects.has(element.name.text)
              ) {
                environmentObjects.add(element.name.text);
                changed = true;
              }
            }
          }
          if (isCoreNamespaceExpression(initializer, coreNamespaces)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const property = bindingPropertyName(element, sourceFile);
              const dynamic = Boolean(
                element.propertyName &&
                ts.isComputedPropertyName(element.propertyName)
              );
              if (
                (dynamic || property === S.createLoggerName) &&
                !createLoggerFunctions.has(element.name.text)
              ) {
                createLoggerFunctions.add(element.name.text);
                changed = true;
              }
              if (
                (dynamic || property === S.redactedWriterName) &&
                !redactedWriterFunctions.has(element.name.text)
              ) {
                redactedWriterFunctions.add(element.name.text);
                changed = true;
              }
            }
          }
          if (isReflectObjectExpression(initializer, reflectObjects)) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const property = bindingPropertyName(element, sourceFile);
              const dynamic = Boolean(
                element.propertyName &&
                ts.isComputedPropertyName(element.propertyName)
              );
              if (
                (dynamic || property === "apply") &&
                !reflectApplyFunctions.has(element.name.text)
              ) {
                reflectApplyFunctions.add(element.name.text);
                changed = true;
              }
              if (
                (dynamic || property === "get") &&
                !reflectGetFunctions.has(element.name.text)
              ) {
                reflectGetFunctions.add(element.name.text);
                changed = true;
              }
            }
          }
          if (isNativeGlobalIdentifier(initializer, "globalThis")) {
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const property = bindingPropertyName(element, sourceFile);
              if (
                property === "process" &&
                !processObjects.has(element.name.text)
              ) {
                processObjects.add(element.name.text);
                changed = true;
              }
              if (property === "Bun" && !bunObjects.has(element.name.text)) {
                bunObjects.add(element.name.text);
                changed = true;
              }
              if (
                property === "console" &&
                !consoleObjects.has(element.name.text)
              ) {
                consoleObjects.add(element.name.text);
                changed = true;
              }
            }
          }
          const initializerTainted = expressionCarriesClinicalText(
            initializer,
            tainted
          );
          for (const element of node.name.elements) {
            const property = bindingPropertyName(element, sourceFile);
            if (!initializerTainted && !isClinicalTextName(property)) continue;
            for (const identifier of bindingIdentifiers(element.name)) {
              if (!tainted.has(identifier.text)) {
                tainted.add(identifier.text);
                changed = true;
              }
            }
          }
        } else if (ts.isArrayBindingPattern(node.name)) {
          for (const identifier of bindingIdentifiers(node.name)) {
            if (
              isLoggerContainerExpression(initializer, loggerContainers) &&
              !loggerObjects.has(identifier.text)
            ) {
              loggerObjects.add(identifier.text);
              changed = true;
            }
            if (
              isLoggerContainerExpression(initializer, loggerContainers) &&
              !loggerContainers.has(identifier.text)
            ) {
              loggerContainers.add(identifier.text);
              changed = true;
            }
            if (
              isRawSinkContainerExpression(initializer, rawSinkContainers) &&
              !rawSinkFunctions.has(identifier.text)
            ) {
              rawSinkFunctions.add(identifier.text);
              changed = true;
            }
            if (
              expressionCarriesClinicalText(initializer, tainted) &&
              !tainted.has(identifier.text)
            ) {
              tainted.add(identifier.text);
              changed = true;
            }
          }
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = unwrap(node.left);
        const source = unwrap(node.right);
        if (
          ts.isPropertyAccessExpression(left) ||
          ts.isElementAccessExpression(left)
        ) {
          const target = rootIdentifierName(left);
          if (target) {
            if (
              (isRawOutputExpression(
                source,
                consoleObjects,
                outputStreams,
                processObjects,
                rawSinkFunctions,
                rawSinkContainers
              ) ||
                literalContainsRawSink(
                  source,
                  consoleObjects,
                  outputStreams,
                  processObjects,
                  rawSinkFunctions,
                  rawSinkContainers
                )) &&
              !rawSinkContainers.has(target)
            ) {
              rawSinkContainers.add(target);
              changed = true;
            }
            if (
              (isLoggerObjectExpression(
                source,
                loggerObjects,
                loggerContainers
              ) ||
                loggerMethod(
                  source,
                  loggerObjects,
                  loggerContainers,
                  loggerMethods
                ) !== undefined ||
                literalContainsLogger(
                  source,
                  loggerObjects,
                  loggerContainers
                )) &&
              !loggerContainers.has(target)
            ) {
              loggerContainers.add(target);
              changed = true;
            }
          }
        }
        if (
          ts.isObjectLiteralExpression(left) &&
          isProcessObjectExpression(source, processObjects)
        ) {
          for (const property of left.properties) {
            const propertyName = property.name?.getText(sourceFile);
            const assigned = ts.isShorthandPropertyAssignment(property)
              ? property.name
              : ts.isPropertyAssignment(property) &&
                  ts.isIdentifier(property.initializer)
                ? property.initializer
                : undefined;
            if (!assigned) continue;
            if (
              propertyName === "env" &&
              !environmentObjects.has(assigned.text)
            ) {
              environmentObjects.add(assigned.text);
              changed = true;
            }
            if (
              (propertyName === "stdout" || propertyName === "stderr") &&
              !outputStreams.has(assigned.text)
            ) {
              outputStreams.add(assigned.text);
              changed = true;
            }
          }
        }
      }

      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isIdentifier(unwrap(node.left))
      ) {
        const target = (unwrap(node.left) as ts.Identifier).text;
        const source = unwrap(node.right);
        if (
          isBunObjectExpression(source, bunObjects) &&
          !bunObjects.has(target)
        ) {
          bunObjects.add(target);
          changed = true;
        }
        if (
          isProcessObjectExpression(source, processObjects) &&
          !processObjects.has(target)
        ) {
          processObjects.add(target);
          changed = true;
        }
        if (
          isReflectObjectExpression(source, reflectObjects) &&
          !reflectObjects.has(target)
        ) {
          reflectObjects.add(target);
          changed = true;
        }
        if (
          isReflectApplyExpression(
            source,
            reflectApplyFunctions,
            reflectObjects
          ) &&
          !reflectApplyFunctions.has(target)
        ) {
          reflectApplyFunctions.add(target);
          changed = true;
        }
        if (
          isReflectGetExpression(source, reflectGetFunctions, reflectObjects) &&
          !reflectGetFunctions.has(target)
        ) {
          reflectGetFunctions.add(target);
          changed = true;
        }
        if (
          ts.isIdentifier(source) &&
          coreNamespaces.has(source.text) &&
          !coreNamespaces.has(target)
        ) {
          coreNamespaces.add(target);
          changed = true;
        }
        if (
          isConsoleObjectExpression(source, consoleObjects) &&
          !consoleObjects.has(target)
        ) {
          consoleObjects.add(target);
          changed = true;
        }
        if (
          isLoggerObjectExpression(source, loggerObjects, loggerContainers) &&
          !loggerObjects.has(target)
        ) {
          loggerObjects.add(target);
          changed = true;
        }
        if (
          ts.isCallExpression(source) &&
          isCreateLoggerExpression(
            source.expression,
            createLoggerFunctions,
            coreNamespaces
          ) &&
          !loggerObjects.has(target)
        ) {
          loggerObjects.add(target);
          changed = true;
        }
        if (
          literalContainsLogger(source, loggerObjects, loggerContainers) &&
          !loggerContainers.has(target)
        ) {
          loggerContainers.add(target);
          changed = true;
        }
        if (
          isLoggerContainerExpression(source, loggerContainers) &&
          !loggerContainers.has(target)
        ) {
          loggerContainers.add(target);
          changed = true;
        }
        if (
          literalContainsRawSink(
            source,
            consoleObjects,
            outputStreams,
            processObjects,
            rawSinkFunctions,
            rawSinkContainers
          ) &&
          !rawSinkContainers.has(target)
        ) {
          rawSinkContainers.add(target);
          changed = true;
        }
        const method = loggerMethod(
          source,
          loggerObjects,
          loggerContainers,
          loggerMethods
        );
        if (method && loggerMethods.get(target) !== method) {
          loggerMethods.set(target, method);
          changed = true;
        }
        if (
          isOutputStreamExpression(source, outputStreams, processObjects) &&
          !outputStreams.has(target)
        ) {
          outputStreams.add(target);
          changed = true;
        }
        if (
          isEnvironmentObject(
            source,
            environmentObjects,
            processObjects,
            bunObjects,
            reflectGetFunctions
          ) &&
          !environmentObjects.has(target)
        ) {
          environmentObjects.add(target);
          changed = true;
        }
        if (
          isRawOutputExpression(
            source,
            consoleObjects,
            outputStreams,
            processObjects,
            rawSinkFunctions,
            rawSinkContainers
          ) &&
          !rawSinkFunctions.has(target)
        ) {
          rawSinkFunctions.add(target);
          changed = true;
        }
        if (
          isCreateLoggerExpression(
            source,
            createLoggerFunctions,
            coreNamespaces
          ) &&
          !createLoggerFunctions.has(target)
        ) {
          createLoggerFunctions.add(target);
          changed = true;
        }
        if (
          isCoreFunctionExpression(
            source,
            S.redactedWriterName,
            redactedWriterFunctions,
            coreNamespaces
          ) &&
          !redactedWriterFunctions.has(target)
        ) {
          redactedWriterFunctions.add(target);
          changed = true;
        }
        if (
          !tainted.has(target) &&
          expressionCarriesClinicalText(source, tainted)
        ) {
          tainted.add(target);
          changed = true;
        }
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }

  return {
    bunObjects,
    consoleObjects,
    coreNamespaces,
    createLoggerFunctions,
    environmentObjects,
    loggerContainers,
    loggerObjects,
    loggerMethods,
    outputStreams,
    processObjects,
    rawSinkContainers,
    rawSinkFunctions,
    redactedWriterFunctions,
    reflectApplyFunctions,
    reflectGetFunctions,
    reflectObjects,
    tainted,
  };
}

function isOutputStreamExpression(
  expression: ts.Expression,
  outputStreams: ReadonlySet<string>,
  processObjects: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return outputStreams.has(value.text);
  const stream = memberName(value);
  const owner = memberOwner(value);
  return (
    owner !== undefined &&
    isProcessObjectExpression(owner, processObjects) &&
    (stream === "stdout" ||
      stream === "stderr" ||
      (stream === undefined && ts.isElementAccessExpression(value)))
  );
}

function isProcessObjectExpression(
  expression: ts.Expression,
  processObjects: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    if (!processObjects.has(value.text)) return false;
    return value.text !== "process" && value.text !== "Bun"
      ? true
      : !hasLexicalShadowing(value, value.text);
  }
  if (
    loadedModuleName(value) === "node:process" ||
    loadedModuleName(value) === "process"
  ) {
    return true;
  }
  if (reflectedGlobalCapability(value, new Set(["Reflect"])) === "process")
    return true;
  if (ts.isConditionalExpression(value)) {
    return (
      isProcessObjectExpression(value.whenTrue, processObjects) ||
      isProcessObjectExpression(value.whenFalse, processObjects)
    );
  }
  if (memberName(value) !== "process") return false;
  const owner = memberOwner(value);
  if (
    isNativeGlobalIdentifier(owner, "globalThis") ||
    isNativeGlobalIdentifier(owner, "global")
  ) {
    return true;
  }
  if (!owner || !ts.isObjectLiteralExpression(owner)) return false;
  return owner.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property))
      return property.name.text === "process";
    return (
      ts.isPropertyAssignment(property) &&
      property.name.getText() === "process" &&
      isProcessObjectExpression(property.initializer, processObjects)
    );
  });
}

function isBunObjectExpression(
  expression: ts.Expression,
  bunObjects: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    if (!bunObjects.has(value.text)) return false;
    return value.text !== "Bun" || !hasLexicalShadowing(value, value.text);
  }
  if (reflectedGlobalCapability(value, new Set(["Reflect"])) === "Bun")
    return true;
  return (
    memberName(value) === "Bun" &&
    isNativeGlobalIdentifier(memberOwner(value), "globalThis")
  );
}

function isReflectObjectExpression(
  expression: ts.Expression,
  reflectObjects: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  return ts.isIdentifier(value) && reflectObjects.has(value.text);
}

function isReflectApplyExpression(
  expression: ts.Expression,
  reflectApplyFunctions: ReadonlySet<string>,
  reflectObjects: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return reflectApplyFunctions.has(value.text);
  const owner = memberOwner(value);
  return (
    memberName(value) === "apply" &&
    owner !== undefined &&
    isReflectObjectExpression(owner, reflectObjects)
  );
}

function isReflectGetExpression(
  expression: ts.Expression,
  reflectGetFunctions: ReadonlySet<string>,
  reflectObjects: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return reflectGetFunctions.has(value.text);
  const owner = memberOwner(value);
  return (
    memberName(value) === "get" &&
    owner !== undefined &&
    isReflectObjectExpression(owner, reflectObjects)
  );
}

function isConsoleObjectExpression(
  expression: ts.Expression,
  consoleObjects: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) {
    if (!consoleObjects.has(value.text)) return false;
    return value.text !== "console" || !hasLexicalShadowing(value, value.text);
  }
  const moduleName = loadedModuleName(value);
  if (
    moduleName === "node:console" ||
    moduleName === "console" ||
    moduleName === "node:util" ||
    moduleName === "util" ||
    moduleName === "node:fs" ||
    moduleName === "fs" ||
    moduleName === "node:fs/promises" ||
    moduleName === "fs/promises"
  ) {
    return true;
  }
  if (reflectedGlobalCapability(value, new Set(["Reflect"])) === "console")
    return true;
  if (memberName(value) === "promises") {
    const owner = memberOwner(value);
    if (owner && isConsoleObjectExpression(owner, consoleObjects)) return true;
  }
  return (
    memberName(value) === "console" &&
    isNativeGlobalIdentifier(memberOwner(value), "globalThis")
  );
}

function isSafeRawNamespaceMemberOwner(
  node: ts.Node,
  sourceFile: ts.SourceFile
): boolean {
  if (!ts.isExpression(node)) return false;
  const parent = node.parent;
  if (
    (!ts.isPropertyAccessExpression(parent) &&
      !ts.isElementAccessExpression(parent)) ||
    parent.expression !== node
  ) {
    return false;
  }
  const root = rootIdentifierName(node);
  if (!root) return false;
  const importSource = sourceFile.statements.find((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      (statement.importClause?.name?.text === root ||
        (bindings &&
          ts.isNamespaceImport(bindings) &&
          bindings.name.text === root)) &&
      (statement.moduleSpecifier.text === "node:util" ||
        statement.moduleSpecifier.text === "util" ||
        statement.moduleSpecifier.text === "node:fs" ||
        statement.moduleSpecifier.text === "fs" ||
        statement.moduleSpecifier.text === "node:fs/promises" ||
        statement.moduleSpecifier.text === "fs/promises")
    );
  });
  if (!importSource || !ts.isImportDeclaration(importSource)) return false;
  const source = (importSource.moduleSpecifier as ts.StringLiteral).text;
  const method = memberName(parent);
  if (!method) return false;
  return source === "node:util" || source === "util"
    ? method !== "debuglog"
    : !RAW_FILE_SYSTEM_METHODS.has(method);
}

function isRawOutputExpression(
  expression: ts.Expression,
  consoleObjects: ReadonlySet<string>,
  outputStreams: ReadonlySet<string>,
  processObjects: ReadonlySet<string>,
  rawSinkFunctions: ReadonlySet<string>,
  rawSinkContainers: ReadonlySet<string>
): boolean {
  const value = callableTarget(expression);
  if (ts.isConditionalExpression(value)) {
    return (
      isRawOutputExpression(
        value.whenTrue,
        consoleObjects,
        outputStreams,
        processObjects,
        rawSinkFunctions,
        rawSinkContainers
      ) ||
      isRawOutputExpression(
        value.whenFalse,
        consoleObjects,
        outputStreams,
        processObjects,
        rawSinkFunctions,
        rawSinkContainers
      )
    );
  }
  if (ts.isIdentifier(value)) return rawSinkFunctions.has(value.text);
  const method = memberName(value);
  const owner = memberOwner(value);
  return (
    (owner !== undefined &&
      isRawSinkContainerExpression(owner, rawSinkContainers)) ||
    (owner !== undefined &&
      isConsoleObjectExpression(owner, consoleObjects) &&
      ((method !== undefined && RAW_CONSOLE_METHODS.has(method)) ||
        (method !== undefined && RAW_FILE_SYSTEM_METHODS.has(method)) ||
        (method === undefined && ts.isElementAccessExpression(value)))) ||
    (owner !== undefined &&
      isOutputStreamExpression(owner, outputStreams, processObjects) &&
      (method === "write" ||
        (method === undefined && ts.isElementAccessExpression(value)))) ||
    (owner !== undefined &&
      isProcessObjectExpression(owner, processObjects) &&
      method !== undefined &&
      RAW_PROCESS_METHODS.has(method))
  );
}

function isRawSinkContainerExpression(
  expression: ts.Expression,
  rawSinkContainers: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isIdentifier(value)) return rawSinkContainers.has(value.text);
  const owner = memberOwner(value);
  return (
    owner !== undefined &&
    isRawSinkContainerExpression(owner, rawSinkContainers)
  );
}

function literalContainsRawSink(
  expression: ts.Expression,
  consoleObjects: ReadonlySet<string>,
  outputStreams: ReadonlySet<string>,
  processObjects: ReadonlySet<string>,
  rawSinkFunctions: ReadonlySet<string>,
  rawSinkContainers: ReadonlySet<string>
): boolean {
  const value = unwrap(expression);
  if (ts.isSpreadElement(value)) {
    return literalContainsRawSink(
      value.expression,
      consoleObjects,
      outputStreams,
      processObjects,
      rawSinkFunctions,
      rawSinkContainers
    );
  }
  if (
    isConsoleObjectExpression(value, consoleObjects) ||
    isOutputStreamExpression(value, outputStreams, processObjects) ||
    isRawOutputExpression(
      value,
      consoleObjects,
      outputStreams,
      processObjects,
      rawSinkFunctions,
      rawSinkContainers
    )
  ) {
    return true;
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.some(
      (element) =>
        ts.isExpression(element) &&
        literalContainsRawSink(
          element,
          consoleObjects,
          outputStreams,
          processObjects,
          rawSinkFunctions,
          rawSinkContainers
        )
    );
  }
  if (!ts.isObjectLiteralExpression(value)) return false;
  return value.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return rawSinkFunctions.has(property.name.text);
    }
    if (!ts.isPropertyAssignment(property) && !ts.isSpreadAssignment(property))
      return false;
    return literalContainsRawSink(
      ts.isPropertyAssignment(property)
        ? property.initializer
        : property.expression,
      consoleObjects,
      outputStreams,
      processObjects,
      rawSinkFunctions,
      rawSinkContainers
    );
  });
}

function expressionCarriesRawSink(
  expression: ts.Expression,
  consoleObjects: ReadonlySet<string>,
  outputStreams: ReadonlySet<string>,
  processObjects: ReadonlySet<string>,
  rawSinkFunctions: ReadonlySet<string>,
  rawSinkContainers: ReadonlySet<string>
): boolean {
  if (
    isConsoleObjectExpression(expression, consoleObjects) ||
    isOutputStreamExpression(expression, outputStreams, processObjects) ||
    literalContainsRawSink(
      expression,
      consoleObjects,
      outputStreams,
      processObjects,
      rawSinkFunctions,
      rawSinkContainers
    ) ||
    isRawOutputExpression(
      expression,
      consoleObjects,
      outputStreams,
      processObjects,
      rawSinkFunctions,
      rawSinkContainers
    ) ||
    isRawSinkContainerExpression(expression, rawSinkContainers)
  ) {
    return true;
  }
  if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isCallExpression(expression)
  ) {
    return false;
  }
  let carries = false;
  expression.forEachChild((child) => {
    if (!carries && ts.isExpression(child)) {
      carries = expressionCarriesRawSink(
        child,
        consoleObjects,
        outputStreams,
        processObjects,
        rawSinkFunctions,
        rawSinkContainers
      );
    }
  });
  return carries;
}

function expressionCarriesCoreLoggerFunction(
  expression: ts.Expression,
  createLoggerFunctions: ReadonlySet<string>,
  redactedWriterFunctions: ReadonlySet<string>,
  coreNamespaces: ReadonlySet<string>
): boolean {
  if (
    isCreateLoggerExpression(
      expression,
      createLoggerFunctions,
      coreNamespaces
    ) ||
    isCoreFunctionExpression(
      expression,
      S.redactedWriterName,
      redactedWriterFunctions,
      coreNamespaces
    )
  ) {
    return true;
  }
  if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isCallExpression(expression)
  ) {
    return false;
  }
  let carries = false;
  expression.forEachChild((child) => {
    if (!carries && ts.isExpression(child)) {
      carries = expressionCarriesCoreLoggerFunction(
        child,
        createLoggerFunctions,
        redactedWriterFunctions,
        coreNamespaces
      );
    }
  });
  return carries;
}

function expressionCarriesLoggerSink(
  expression: ts.Expression,
  loggerObjects: ReadonlySet<string>,
  loggerContainers: ReadonlySet<string>,
  loggerMethods: ReadonlyMap<string, string>
): boolean {
  if (
    isLoggerObjectExpression(expression, loggerObjects, loggerContainers) ||
    isLoggerContainerExpression(expression, loggerContainers) ||
    loggerMethod(expression, loggerObjects, loggerContainers, loggerMethods) !==
      undefined
  ) {
    return true;
  }
  if (
    ts.isArrowFunction(expression) ||
    ts.isFunctionExpression(expression) ||
    ts.isCallExpression(expression)
  ) {
    return false;
  }
  let carries = false;
  expression.forEachChild((child) => {
    if (!carries && ts.isExpression(child)) {
      carries = expressionCarriesLoggerSink(
        child,
        loggerObjects,
        loggerContainers,
        loggerMethods
      );
    }
  });
  return carries;
}

function isCreateLoggerExpression(
  expression: ts.Expression,
  createLoggerFunctions: ReadonlySet<string>,
  coreNamespaces: ReadonlySet<string>
): boolean {
  return isCoreFunctionExpression(
    expression,
    S.createLoggerName,
    createLoggerFunctions,
    coreNamespaces
  );
}

function isCoreFunctionExpression(
  expression: ts.Expression,
  exportedName: string,
  importedFunctions: ReadonlySet<string>,
  coreNamespaces: ReadonlySet<string>
): boolean {
  const value = callableTarget(expression);
  if (ts.isIdentifier(value)) return importedFunctions.has(value.text);
  return (
    memberName(value) === exportedName &&
    Boolean(
      memberOwner(value) &&
      isCoreNamespaceExpression(
        memberOwner(value) as ts.Expression,
        coreNamespaces
      )
    )
  );
}

function isCoreLoggerSink(file: string, node: ts.CallExpression): boolean {
  if (file !== S.coreLoggerFile) return false;
  const sourceFile = node.getSourceFile();
  let approved = CORE_LOGGER_SOURCE_APPROVAL.get(sourceFile);
  if (approved === undefined) {
    approved = sourceSha256(sourceFile) === S.coreLoggerSha256;
    CORE_LOGGER_SOURCE_APPROVAL.set(sourceFile, approved);
  }
  if (!approved) return false;
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  if (
    !current ||
    !ts.isFunctionDeclaration(current) ||
    current.name?.text !== "writeLogRecord"
  ) {
    return false;
  }
  if (!ts.isSourceFile(current.parent)) return false;
  const target = unwrap(node.expression);
  const owner = memberOwner(target);
  if (
    memberName(target) !== "write" ||
    !owner ||
    !ts.isElementAccessExpression(owner) ||
    identifierName(owner.expression) !== "process" ||
    identifierName(owner.argumentExpression) !== "destination"
  ) {
    return false;
  }
  const value = node.arguments[0] && unwrap(node.arguments[0]);
  if (
    value !== undefined &&
    ts.isIdentifier(value) &&
    value.text === "LOG_FALLBACK_RECORD"
  ) {
    return hasFixedFallbackRecord(sourceFile, value.text);
  }
  return (
    value !== undefined &&
    ts.isTemplateExpression(value) &&
    value.templateSpans.length === 1 &&
    identifierName(value.templateSpans[0]?.expression) === "line" &&
    value.templateSpans[0]?.literal.text === "\n" &&
    hasSafeSerializedLine(current)
  );
}

function sourceSha256(sourceFile: ts.SourceFile): string {
  let digest = SOURCE_SHA256.get(sourceFile);
  if (digest === undefined) {
    digest = createHash("sha256")
      .update(sourceFile.getFullText())
      .digest("hex");
    SOURCE_SHA256.set(sourceFile, digest);
  }
  return digest;
}

function isApprovedRawFileOutputCall(
  file: string,
  node: ts.CallExpression,
  sourceFile: ts.SourceFile
): boolean {
  const approval = S.approvedRawFileOutputs.get(file);
  if (
    !approval ||
    sourceSha256(sourceFile) !== approval.sha256 ||
    identifierName(node.expression) !== "writeFile"
  ) {
    return false;
  }
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  return approval.calls.has(`${position.line + 1}:${position.character + 1}`);
}

function hasFixedFallbackRecord(
  sourceFile: ts.SourceFile,
  name: string
): boolean {
  return sourceFile.statements.some((statement) => {
    if (!ts.isVariableStatement(statement)) return false;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0)
      return false;
    return statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer !== undefined &&
        ts.isStringLiteral(declaration.initializer) &&
        declaration.initializer.text ===
          '{"level":"error","service":"logger","msg":"log.record-failed"}\n'
    );
  });
}

function hasSafeSerializedLine(boundary: ts.FunctionDeclaration): boolean {
  let declaration: ts.VariableDeclaration | undefined;
  let eventDeclaration: ts.VariableDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionLike(node) && node !== boundary) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "line"
    ) {
      declaration = node;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "event"
    ) {
      eventDeclaration = node;
    }
    node.forEachChild(visit);
  };
  boundary.body?.forEachChild(visit);
  if (!declaration?.initializer || !eventDeclaration?.initializer) return false;
  const event = unwrap(eventDeclaration.initializer);
  if (
    !ts.isCallExpression(event) ||
    identifierName(event.expression) !== "safeEventName" ||
    identifierName(event.arguments[0]) !== "message"
  ) {
    return false;
  }
  const declarationList = declaration.parent;
  if (
    !ts.isVariableDeclarationList(declarationList) ||
    (declarationList.flags & ts.NodeFlags.Const) === 0
  ) {
    return false;
  }
  const stringify = unwrap(declaration.initializer);
  if (!ts.isCallExpression(stringify)) return false;
  if (
    memberName(stringify.expression) !== "stringify" ||
    identifierName(memberOwner(stringify.expression)) !== "JSON"
  ) {
    return false;
  }
  const record = stringify.arguments[0] && unwrap(stringify.arguments[0]);
  if (
    !record ||
    !ts.isObjectLiteralExpression(record) ||
    record.properties.length !== 5
  ) {
    return false;
  }
  let redactedFields = false;
  let timestamp = false;
  let level = false;
  let service = false;
  let message = false;
  for (const property of record.properties) {
    if (ts.isSpreadAssignment(property)) {
      const call = unwrap(property.expression);
      redactedFields =
        ts.isCallExpression(call) &&
        identifierName(call.expression) === "redactFields" &&
        identifierName(call.arguments[0]) === "fields" &&
        identifierName(call.arguments[1]) === "event";
      continue;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      level = property.name.text === "level";
      continue;
    }
    if (!ts.isPropertyAssignment(property)) return false;
    const name = property.name.getText();
    const initializer = unwrap(property.initializer);
    if (name === "ts" && ts.isCallExpression(initializer)) {
      const owner = memberOwner(initializer.expression);
      timestamp =
        memberName(initializer.expression) === "toISOString" &&
        owner !== undefined &&
        ts.isNewExpression(owner) &&
        identifierName(owner.expression) === "Date";
    }
    if (name === "service" && ts.isCallExpression(initializer)) {
      service =
        identifierName(initializer.expression) === "safeServiceName" &&
        identifierName(initializer.arguments[0]) === "service";
    }
    if (name === "msg") message = identifierName(initializer) === "event";
  }
  return redactedFields && timestamp && level && service && message;
}

function isEnvironmentObject(
  node: ts.Node,
  environmentObjects: ReadonlySet<string>,
  processObjects: ReadonlySet<string>,
  bunObjects: ReadonlySet<string>,
  reflectGetFunctions: ReadonlySet<string> = new Set()
): boolean {
  if (ts.isIdentifier(node)) return environmentObjects.has(node.text);
  if (
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    memberName(node) === "env"
  ) {
    const owner = memberOwner(node);
    if (
      owner &&
      ts.isMetaProperty(owner) &&
      owner.keywordToken === ts.SyntaxKind.ImportKeyword &&
      owner.name.text === "meta"
    ) {
      return true;
    }
  }
  if (ts.isCallExpression(node)) {
    const target = unwrap(node.expression);
    return (
      isReflectGetExpression(
        target,
        reflectGetFunctions,
        new Set(["Reflect"])
      ) &&
      node.arguments[0] !== undefined &&
      (isProcessObjectExpression(node.arguments[0], processObjects) ||
        isBunObjectExpression(node.arguments[0], bunObjects)) &&
      (staticStringValue(node.arguments[1]) === "env" ||
        staticStringValue(node.arguments[1]) === undefined)
    );
  }
  if (
    !ts.isPropertyAccessExpression(node) &&
    !ts.isElementAccessExpression(node)
  )
    return false;
  const owner = memberOwner(node);
  if (
    !owner ||
    (!isBunObjectExpression(owner, bunObjects) &&
      !isProcessObjectExpression(owner, processObjects))
  ) {
    return false;
  }
  const name = memberName(node);
  if (
    ts.isElementAccessExpression(node) &&
    isTypedOutputStreamSelector(node.argumentExpression, node)
  ) {
    return false;
  }
  return (
    name === "env" || (name === undefined && ts.isElementAccessExpression(node))
  );
}

function isTypedOutputStreamSelector(
  selector: ts.Expression | undefined,
  useSite: ts.Node
): boolean {
  const name = identifierName(selector);
  if (!name) return false;
  let current: ts.Node | undefined = useSite.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionLike(current)) {
      const parameter = current.parameters.find(
        (candidate) =>
          ts.isIdentifier(candidate.name) && candidate.name.text === name
      );
      if (!parameter?.type) return false;
      const types = ts.isUnionTypeNode(parameter.type)
        ? parameter.type.types
        : [parameter.type];
      return types.every(
        (type) =>
          ts.isLiteralTypeNode(type) &&
          ts.isStringLiteral(type.literal) &&
          (type.literal.text === "stdout" || type.literal.text === "stderr")
      );
    }
    current = current.parent;
  }
  return false;
}

function rawEnvironmentKey(
  node: ts.Node,
  environmentObjects: ReadonlySet<string>,
  processObjects: ReadonlySet<string>,
  bunObjects: ReadonlySet<string>,
  reflectGetFunctions: ReadonlySet<string>
): string | undefined {
  if (isCoreLoggerDestinationAccess(fileForNode(node), node, processObjects))
    return undefined;
  if (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node)
  ) {
    const owner = memberOwner(node);
    if (
      owner &&
      isCoreLoggerDestinationAccess(fileForNode(node), owner, processObjects)
    ) {
      return undefined;
    }
    if (
      owner &&
      isEnvironmentObject(
        owner,
        environmentObjects,
        processObjects,
        bunObjects,
        reflectGetFunctions
      )
    ) {
      return memberName(node) ?? "*";
    }
  }
  if (
    !isEnvironmentObject(
      node,
      environmentObjects,
      processObjects,
      bunObjects,
      reflectGetFunctions
    )
  ) {
    return undefined;
  }
  if (
    ts.isIdentifier(node) &&
    ((ts.isVariableDeclaration(node.parent) && node.parent.name === node) ||
      (ts.isBindingElement(node.parent) && node.parent.name === node) ||
      ts.isImportSpecifier(node.parent) ||
      ts.isImportClause(node.parent) ||
      ts.isNamespaceImport(node.parent) ||
      (ts.isBinaryExpression(node.parent) && node.parent.left === node))
  ) {
    return undefined;
  }
  if (
    node.parent &&
    (ts.isPropertyAccessExpression(node.parent) ||
      ts.isElementAccessExpression(node.parent)) &&
    memberOwner(node.parent) === node
  ) {
    return undefined;
  }
  return "*";
}

function fileForNode(node: ts.Node): string {
  return node.getSourceFile().fileName;
}

function isCoreLoggerDestinationAccess(
  file: string,
  node: ts.Node,
  processObjects: ReadonlySet<string>
): boolean {
  if (file !== S.coreLoggerFile || !ts.isElementAccessExpression(node))
    return false;
  if (identifierName(node.argumentExpression) !== "destination") return false;
  if (!isProcessObjectExpression(node.expression, processObjects)) return false;
  return containingFunctionDeclaration(node)?.name?.text === "writeLogRecord";
}

function containingFunctionDeclaration(
  node: ts.Node
): ts.FunctionDeclaration | undefined {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isFunctionDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function nodeContainsIdentifier(node: ts.Node, name: string): boolean {
  if (ts.isIdentifier(node)) return node.text === name;
  let contains = false;
  node.forEachChild((child) => {
    if (!contains) contains = nodeContainsIdentifier(child, name);
  });
  return contains;
}

function callbackWritesIdentifier(
  callback: ts.ArrowFunction,
  name: string
): boolean {
  let writes = false;
  const visit = (node: ts.Node) => {
    if (writes) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      nodeContainsIdentifier(node.left, name)
    ) {
      writes = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      nodeContainsIdentifier(node.operand, name)
    ) {
      writes = true;
      return;
    }
    node.forEachChild(visit);
  };
  callback.body.forEachChild(visit);
  return writes;
}

function isCreateServiceEnvKeyRead(
  file: string,
  node: ts.Node,
  key: string
): boolean {
  if (file !== S.envKeyMapperFile || key !== "*") return false;
  if (!ts.isElementAccessExpression(node)) return false;
  if (identifierName(node.argumentExpression) !== "key") return false;
  if (
    memberName(node.expression) !== "env" ||
    identifierName(memberOwner(node.expression)) !== "process"
  ) {
    return false;
  }

  let callback: ts.ArrowFunction | undefined;
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isArrowFunction(current)) {
      callback = current;
      break;
    }
    current = current.parent;
  }
  const parameter = callback?.parameters[0]?.name;
  if (
    !callback ||
    !parameter ||
    !ts.isIdentifier(parameter) ||
    parameter.text !== "key"
  ) {
    return false;
  }
  if (callbackWritesIdentifier(callback, parameter.text)) return false;
  if (
    !ts.isCallExpression(callback.parent) ||
    !callback.parent.arguments.includes(callback)
  ) {
    return false;
  }
  const mapTarget = unwrap(callback.parent.expression);
  if (
    memberName(mapTarget) !== "map" ||
    identifierName(memberOwner(mapTarget)) !== "keys"
  ) {
    return false;
  }
  const boundary = containingFunctionDeclaration(node);
  return (
    S.envKeyMapperFunction !== "" &&
    boundary?.name?.text === S.envKeyMapperFunction &&
    ts.isSourceFile(boundary.parent)
  );
}

function isPostgresChildEnvironmentSpread(
  file: string,
  node: ts.Node,
  key: string
): boolean {
  if (file !== S.envChildSpreadFile || key !== "*") return false;
  if (!ts.isPropertyAccessExpression(node) || memberName(node) !== "env")
    return false;
  if (
    identifierName(memberOwner(node)) !== "process" ||
    !ts.isSpreadAssignment(node.parent)
  ) {
    return false;
  }
  const environment = node.parent.parent;
  if (!ts.isObjectLiteralExpression(environment)) return false;
  const password = environment.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      property.name.getText() === "PGPASSWORD" &&
      identifierName(property.initializer) === "password"
  );
  if (!password || !ts.isPropertyAssignment(environment.parent)) return false;
  if (environment.parent.name.getText() !== "env") return false;
  const boundary = containingFunctionDeclaration(node);
  return (
    S.envChildSpreadFunction !== "" &&
    boundary?.name?.text === S.envChildSpreadFunction &&
    ts.isSourceFile(boundary.parent)
  );
}

function isAllowedRawEnvironmentRead(
  file: string,
  node: ts.Node,
  key: string,
  sourceFile: ts.SourceFile
): boolean {
  if (
    file === S.coreLoggerFile &&
    (ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)) &&
    ts.isCallExpression(node.parent) &&
    node.parent.expression === node &&
    isCoreLoggerSink(file, node.parent)
  ) {
    return true;
  }
  if (
    isCreateServiceEnvKeyRead(file, node, key) ||
    isPostgresChildEnvironmentSpread(file, node, key)
  ) {
    return true;
  }
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile)
  );
  const allowedKeys = S.rawEnvAllowlist
    .get(file)
    ?.get(`${position.line + 1}:${position.character + 1}`);
  return allowedKeys?.has(key) === true;
}

function callArguments(
  expression: ts.Expression | undefined
): readonly ts.Expression[] {
  if (!expression) return [];
  const value = unwrap(expression);
  if (!ts.isArrayLiteralExpression(value)) return [];
  return value.elements.filter(ts.isExpression);
}

function unsafeScalarFieldSources(
  file: string,
  event: string,
  fields: ts.Expression | undefined,
  sourceFile: ts.SourceFile
): ts.Node[] {
  const prefix = `${file}:${event}:`;
  const scalarFields = S.operationalScalarFields.get(event);
  if (!scalarFields || !fields) return [];
  const value = unwrap(fields);
  if (!ts.isObjectLiteralExpression(value)) return [fields];
  const expectedDigest = S.approvedScalarSourceSha256.get(file);
  const approvedSource =
    expectedDigest !== undefined && sourceSha256(sourceFile) === expectedDigest;
  const call = ts.isCallExpression(value.parent) ? value.parent : undefined;
  const callStart = call?.getStart(sourceFile);
  const callPosition =
    callStart === undefined
      ? undefined
      : sourceFile.getLineAndCharacterOfPosition(callStart);
  const callLocation = callPosition
    ? `${callPosition.line + 1}:${callPosition.character + 1}`
    : undefined;

  const unsafe: ts.Node[] = [];
  for (const property of value.properties) {
    if (
      ts.isSpreadAssignment(property) ||
      ts.isComputedPropertyName(property.name)
    ) {
      unsafe.push(property);
      continue;
    }
    const field = property.name
      ?.getText(sourceFile)
      .replace(/^['"]|['"]$/g, "");
    if (!field || !scalarFields.has(field)) continue;
    const expression = ts.isPropertyAssignment(property)
      ? property.initializer
      : ts.isShorthandPropertyAssignment(property)
        ? property.name
        : undefined;
    const allowed = S.safeScalarSources.get(`${prefix}${field}`);
    if (
      !approvedSource ||
      !expression ||
      !allowed ||
      callLocation !== allowed.call ||
      expression.getText(sourceFile) !== allowed.expression
    ) {
      unsafe.push(property);
    }
  }
  return unsafe;
}

function invokedCall(
  node: ts.CallExpression,
  reflectApplyFunctions: ReadonlySet<string>,
  reflectObjects: ReadonlySet<string>
): {
  arguments: readonly ts.Expression[];
  target: ts.Expression;
} {
  const expression = unwrap(node.expression);
  const method = memberName(expression);
  const owner = memberOwner(expression);
  if (
    isReflectApplyExpression(
      expression,
      reflectApplyFunctions,
      reflectObjects
    ) &&
    node.arguments[0]
  ) {
    return {
      arguments: callArguments(node.arguments[2]),
      target: node.arguments[0],
    };
  }
  if (method === "call" && owner) {
    return { arguments: node.arguments.slice(1), target: owner };
  }
  if (method === "apply" && owner) {
    return { arguments: callArguments(node.arguments[1]), target: owner };
  }
  return { arguments: node.arguments, target: node.expression };
}

export function analyzeTypeScriptSource(
  file: string,
  source: string,
  settings: Settings,
  scope: FileScope
): Violation[] {
  S = settings;
  const scriptKind = file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const {
    bunObjects,
    consoleObjects,
    coreNamespaces,
    createLoggerFunctions,
    environmentObjects,
    loggerContainers,
    loggerObjects,
    loggerMethods,
    outputStreams,
    processObjects,
    rawSinkContainers,
    rawSinkFunctions,
    redactedWriterFunctions,
    reflectApplyFunctions,
    reflectGetFunctions,
    reflectObjects,
    tainted,
  } = collectAliases(sourceFile);
  const violations: Violation[] = [];
  const seen = new Set<string>();

  const report = (node: ts.Node, rule: string, message: string) => {
    const start = node.getStart(sourceFile);
    const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
    const key = `${start}:${rule}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(violation(file, line, rule, message));
  };

  const containingDirectLoggerCall = (
    node: ts.Node
  ): ts.CallExpression | undefined => {
    let current = node;
    while (current.parent && !ts.isSourceFile(current.parent)) {
      const parent = current.parent;
      if (ts.isCallExpression(parent)) {
        if (
          parent.expression !== current ||
          memberName(parent.expression) === "bind"
        ) {
          return undefined;
        }
        const invoked = invokedCall(
          parent,
          reflectApplyFunctions,
          reflectObjects
        );
        if (
          loggerMethod(
            invoked.target,
            loggerObjects,
            loggerContainers,
            loggerMethods
          ) !== undefined ||
          isCreateLoggerExpression(
            invoked.target,
            createLoggerFunctions,
            coreNamespaces
          ) ||
          isCoreFunctionExpression(
            invoked.target,
            S.redactedWriterName,
            redactedWriterFunctions,
            coreNamespaces
          )
        ) {
          return parent;
        }
        return undefined;
      }
      if (
        ts.isVariableDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isReturnStatement(parent) ||
        ts.isJsxAttribute(parent) ||
        ts.isExportAssignment(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent)
      ) {
        return undefined;
      }
      current = parent;
    }
    return undefined;
  };

  const isCoreLoggerSinkNode = (node: ts.Node): boolean => {
    if (file !== S.coreLoggerFile) return false;
    let current = node;
    while (current.parent && !ts.isSourceFile(current.parent)) {
      const parent = current.parent;
      if (ts.isCallExpression(parent)) {
        return parent.expression === current && isCoreLoggerSink(file, parent);
      }
      if (
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === current
      ) {
        current = parent;
        continue;
      }
      return false;
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      if (
        node.moduleSpecifier.text === "node:console" ||
        node.moduleSpecifier.text === "console"
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Node Console instances bypass the validated logger adapter"
        );
      }
      if (S.unsafeLoggerModules.has(node.moduleSpecifier.text)) {
        report(
          node,
          "phi-safe-logger-required",
          "Third-party output loggers bypass the validated logger adapter"
        );
      }
      if (
        (node.moduleSpecifier.text === "node:process" ||
          node.moduleSpecifier.text === "process") &&
        (node.importClause?.name ||
          (node.importClause?.namedBindings &&
            ts.isNamespaceImport(node.importClause.namedBindings)))
      ) {
        report(
          node,
          "environment-adapter-required",
          "Broad process imports bypass the environment adapter boundary"
        );
      }
      if (importsRuntimeModuleFactory(node)) {
        report(
          node,
          "dynamic-module-source-forbidden",
          "Runtime module factories erase architecture-check provenance"
        );
        report(
          node,
          "environment-adapter-required",
          "Runtime module factories can bypass the environment adapter"
        );
      }
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      if (exportsLoggerCapability(node)) {
        report(
          node,
          "logger-callback-forbidden",
          "Logger capabilities must not be re-exported through unchecked modules"
        );
      }
      if (
        ts.isStringLiteral(node.moduleSpecifier) &&
        (RAW_CAPABILITY_MODULES.has(node.moduleSpecifier.text) ||
          S.unsafeLoggerModules.has(node.moduleSpecifier.text))
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Raw runtime capabilities must not be re-exported through unchecked modules"
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const moduleName = loadedModuleName(node);
      if (
        isModuleLoadCall(node) &&
        (node.arguments.length !== 1 || !isStaticString(node.arguments[0]))
      ) {
        report(
          node,
          "dynamic-module-source-forbidden",
          "Module sources must be fixed literals so architecture checks retain provenance"
        );
      }
      if (isCorePackage(moduleName)) {
        report(
          node,
          "logger-callback-forbidden",
          "Load logger functions through static imports so architecture checks retain provenance"
        );
      }
      if (isLoggerModule(moduleName)) {
        report(
          node,
          "logger-callback-forbidden",
          "Load service loggers through static imports so architecture checks retain provenance"
        );
      }
      if (moduleName && S.unsafeLoggerModules.has(moduleName)) {
        report(
          node,
          "phi-safe-logger-required",
          "Third-party output loggers bypass the validated logger adapter"
        );
      }
      if (moduleName === "node:module" || moduleName === "module") {
        report(
          node,
          "dynamic-module-source-forbidden",
          "Runtime module factories erase architecture-check provenance"
        );
      }

      const capability = reflectedGlobalCapability(
        node,
        reflectObjects,
        reflectGetFunctions
      );
      if (capability === "console" || capability === "*") {
        report(
          node,
          "phi-safe-logger-required",
          "Reflective console access bypasses the validated logger adapter"
        );
      }
      if (
        capability === "process" ||
        capability === "Bun" ||
        capability === "*"
      ) {
        report(
          node,
          "environment-adapter-required",
          "Reflective runtime access bypasses the environment adapter"
        );
      }
    }

    if (
      ts.isExpression(node) &&
      !isInsideTypePosition(node) &&
      !isCoreLoggerPublicExport(file, node) &&
      !(ts.isIdentifier(node) && isIdentifierDeclarationName(node))
    ) {
      const referencesRawSink =
        isConsoleObjectExpression(node, consoleObjects) ||
        isOutputStreamExpression(node, outputStreams, processObjects) ||
        isRawOutputExpression(
          node,
          consoleObjects,
          outputStreams,
          processObjects,
          rawSinkFunctions,
          rawSinkContainers
        ) ||
        isRawSinkContainerExpression(node, rawSinkContainers);
      const parentReferencesRawSink =
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node &&
        (isRawOutputExpression(
          node.parent,
          consoleObjects,
          outputStreams,
          processObjects,
          rawSinkFunctions,
          rawSinkContainers
        ) ||
          isOutputStreamExpression(
            node.parent,
            outputStreams,
            processObjects
          ) ||
          isRawSinkContainerExpression(node.parent, rawSinkContainers));
      const directRawInvocation =
        (ts.isCallExpression(node.parent) && node.parent.expression === node) ||
        (ts.isTaggedTemplateExpression(node.parent) &&
          node.parent.tag === node);
      if (
        referencesRawSink &&
        !parentReferencesRawSink &&
        !directRawInvocation &&
        !isSafeRawNamespaceMemberOwner(node, sourceFile) &&
        !isCoreLoggerSinkNode(node)
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Raw output sinks must remain inside the validated logger adapter"
        );
      }

      const parent = node.parent;
      const isDirectMemberOwner =
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      if (
        !isDirectMemberOwner &&
        (isProcessObjectExpression(node, processObjects) ||
          isBunObjectExpression(node, bunObjects))
      ) {
        report(
          node,
          "environment-adapter-required",
          "Runtime capability objects must not be aliased, returned, or transported"
        );
      }

      const runtimeMemberOwner = memberOwner(node);
      if (
        memberName(node) === "getBuiltinModule" &&
        runtimeMemberOwner &&
        isProcessObjectExpression(runtimeMemberOwner, processObjects)
      ) {
        report(
          node,
          "environment-adapter-required",
          "Runtime module access bypasses static environment and output checks"
        );
      }

      const referencesLogger =
        isLoggerObjectExpression(node, loggerObjects, loggerContainers) ||
        isLoggerContainerExpression(node, loggerContainers) ||
        loggerMethod(node, loggerObjects, loggerContainers, loggerMethods) !==
          undefined ||
        isCreateLoggerExpression(node, createLoggerFunctions, coreNamespaces) ||
        isCoreFunctionExpression(
          node,
          S.redactedWriterName,
          redactedWriterFunctions,
          coreNamespaces
        );
      const parentReferencesLogger =
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node &&
        (isLoggerObjectExpression(
          node.parent,
          loggerObjects,
          loggerContainers
        ) ||
          isLoggerContainerExpression(node.parent, loggerContainers) ||
          loggerMethod(
            node.parent,
            loggerObjects,
            loggerContainers,
            loggerMethods
          ) !== undefined);
      if (
        referencesLogger &&
        !parentReferencesLogger &&
        !containingDirectLoggerCall(node)
      ) {
        report(
          node,
          "logger-callback-forbidden",
          "Logger references must be invoked directly so event and field checks remain enforceable"
        );
      }
    }

    const environmentKey = rawEnvironmentKey(
      node,
      environmentObjects,
      processObjects,
      bunObjects,
      reflectGetFunctions
    );
    if (environmentKey) {
      if (
        !isAllowedRawEnvironmentRead(file, node, environmentKey, sourceFile)
      ) {
        report(
          node,
          "environment-adapter-required",
          "Read runtime environment through the validated env helper or an explicit standalone adapter"
        );
      }
    }

    if (
      scope.tenantRoute &&
      ts.isIdentifier(node) &&
      S.internalDbNames.has(node.text)
    ) {
      report(
        node,
        "tenant-bypass-boundary",
        "Routes must use an authorized service boundary instead of an internal database handle"
      );
    }

    if (ts.isReturnStatement(node) && node.expression) {
      if (
        expressionCarriesRawSink(
          node.expression,
          consoleObjects,
          outputStreams,
          processObjects,
          rawSinkFunctions,
          rawSinkContainers
        )
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Raw output sinks must not be returned from functions"
        );
      }
      if (
        expressionCarriesLoggerSink(
          node.expression,
          loggerObjects,
          loggerContainers,
          loggerMethods
        ) ||
        expressionCarriesCoreLoggerFunction(
          node.expression,
          createLoggerFunctions,
          redactedWriterFunctions,
          coreNamespaces
        )
      ) {
        report(
          node,
          "logger-callback-forbidden",
          "Logger objects and methods must not be returned from functions"
        );
      }
    }

    if (ts.isNewExpression(node)) {
      const arguments_ = node.arguments ?? [];
      if (
        scope.imageRoute &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === "Blob" || node.expression.text === "FormData")
      ) {
        report(
          node,
          "no-image-body-upload",
          "Image bytes must use the direct object-storage upload protocol"
        );
      }
      if (
        arguments_.some((argument) =>
          expressionCarriesRawSink(
            argument,
            consoleObjects,
            outputStreams,
            processObjects,
            rawSinkFunctions,
            rawSinkContainers
          )
        )
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Raw output sinks must not be passed through constructors"
        );
      }
      if (
        arguments_.some(
          (argument) =>
            expressionCarriesLoggerSink(
              argument,
              loggerObjects,
              loggerContainers,
              loggerMethods
            ) ||
            expressionCarriesCoreLoggerFunction(
              argument,
              createLoggerFunctions,
              redactedWriterFunctions,
              coreNamespaces
            )
        )
      ) {
        report(
          node,
          "logger-callback-forbidden",
          "Logger objects and methods must not be passed through constructors"
        );
      }
    }

    if (ts.isTaggedTemplateExpression(node)) {
      if (
        isRawOutputExpression(
          node.tag,
          consoleObjects,
          outputStreams,
          processObjects,
          rawSinkFunctions,
          rawSinkContainers
        )
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Raw output sinks must not be used as template tags"
        );
      }
      if (
        loggerMethod(
          node.tag,
          loggerObjects,
          loggerContainers,
          loggerMethods
        ) !== undefined ||
        isCoreFunctionExpression(
          node.tag,
          S.redactedWriterName,
          redactedWriterFunctions,
          coreNamespaces
        )
      ) {
        report(
          node,
          "static-log-message",
          "Logger messages must be string literals"
        );
      }
    }

    if (ts.isCallExpression(node)) {
      const invocationName = memberName(node.expression);
      const bindsCallable = invocationName === "bind";
      const invoked = invokedCall(node, reflectApplyFunctions, reflectObjects);
      if (
        !bindsCallable &&
        isRawOutputExpression(
          invoked.target,
          consoleObjects,
          outputStreams,
          processObjects,
          rawSinkFunctions,
          rawSinkContainers
        ) &&
        !isCoreLoggerSink(file, node) &&
        !isApprovedRawFileOutputCall(file, node, sourceFile)
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Raw output bypasses mandatory redaction; use the service logger adapter"
        );
      }
      if (
        !bindsCallable &&
        invoked.arguments.some((argument) =>
          expressionCarriesRawSink(
            argument,
            consoleObjects,
            outputStreams,
            processObjects,
            rawSinkFunctions,
            rawSinkContainers
          )
        )
      ) {
        report(
          node,
          "phi-safe-logger-required",
          "Raw output sinks must not be passed through callbacks or containers"
        );
      }
      if (
        !bindsCallable &&
        invoked.arguments.some(
          (argument) =>
            expressionCarriesLoggerSink(
              argument,
              loggerObjects,
              loggerContainers,
              loggerMethods
            ) ||
            expressionCarriesCoreLoggerFunction(
              argument,
              createLoggerFunctions,
              redactedWriterFunctions,
              coreNamespaces
            )
        )
      ) {
        report(
          node,
          "logger-callback-forbidden",
          "Logger objects and methods must not be passed through callbacks or containers"
        );
      }

      const callsCreateLogger =
        !bindsCallable &&
        isCreateLoggerExpression(
          invoked.target,
          createLoggerFunctions,
          coreNamespaces
        );
      if (
        callsCreateLogger &&
        file !== S.coreLoggerFile &&
        !matchesAny(file, S.loggerFactoryFiles)
      ) {
        report(
          node,
          "logger-construction-boundary",
          "Construct loggers only in the designated logger adapter files"
        );
      }

      if (callsCreateLogger && !isStaticString(invoked.arguments[0])) {
        report(
          node,
          "static-logger-service",
          "Logger service names must be string literals"
        );
      }

      const callsRedactedWriter =
        !bindsCallable &&
        isCoreFunctionExpression(
          invoked.target,
          S.redactedWriterName,
          redactedWriterFunctions,
          coreNamespaces
        );
      if (callsRedactedWriter) {
        const message = invoked.arguments[0];
        if (!isStaticString(message)) {
          report(
            node,
            "static-log-message",
            "Logger messages must be string literals"
          );
        } else if (!S.eventNames.has(message.text)) {
          report(
            node,
            "safe-log-event-required",
            "Logger messages must use a registered event identifier"
          );
        } else {
          for (const unsafe of unsafeScalarFieldSources(
            file,
            message.text,
            invoked.arguments[1],
            sourceFile
          )) {
            report(
              unsafe,
              "safe-log-scalar-source-required",
              "Operational scalars must use the reviewed source for this event and field"
            );
          }
        }
      }

      const method = bindsCallable
        ? undefined
        : loggerMethod(
            invoked.target,
            loggerObjects,
            loggerContainers,
            loggerMethods
          );
      if (method) {
        const message = invoked.arguments[0];
        if (!isStaticString(message)) {
          report(
            node,
            "static-log-message",
            "Logger messages must be string literals"
          );
        } else if (!S.eventNames.has(message.text)) {
          report(
            node,
            "safe-log-event-required",
            "Logger messages must use a registered event identifier"
          );
        } else {
          for (const unsafe of unsafeScalarFieldSources(
            file,
            message.text,
            invoked.arguments[1],
            sourceFile
          )) {
            report(
              unsafe,
              "safe-log-scalar-source-required",
              "Operational scalars must use the reviewed source for this event and field"
            );
          }
        }
        if (
          invoked.arguments
            .slice(1)
            .some((argument) =>
              expressionCarriesClinicalText(argument, tainted)
            )
        ) {
          report(
            node,
            "no-direct-clinical-log-argument",
            "Do not pass OCR, document, transcript, or patient-name text to a logger"
          );
        }
      }

      const callOwner = memberOwner(node.expression);
      const callMethod = memberName(node.expression);
      const inApiRoute = scope.imageRoute;
      const imageBodyRead =
        (inApiRoute &&
          callMethod === "File" &&
          identifierName(callOwner) === "t") ||
        (inApiRoute &&
          (callMethod === "arrayBuffer" ||
            callMethod === "blob" ||
            callMethod === "bytes" ||
            callMethod === "formData" ||
            callMethod === "getReader")) ||
        (scope.imageService && callMethod === "arrayBuffer");
      if (imageBodyRead) {
        report(
          node,
          "no-image-body-upload",
          "Image bytes must use the direct object-storage upload protocol"
        );
      }
    }

    node.forEachChild(visit);
  };
  visit(sourceFile);
  return violations;
}
