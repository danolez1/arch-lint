import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface CallGraphFunction {
  id: string;
  name: string;
  file: string;
  line: number;
}

export interface CallGraphEdge {
  from: string;
  to: string;
  file: string;
  line: number;
  kind: "call" | "construct";
}

export interface CallGraph {
  functions: CallGraphFunction[];
  calls: CallGraphEdge[];
}

export interface CallGraphOptions {
  root: string;
  entryFile?: string;
  functionName?: string;
}

type FunctionRecord = CallGraphFunction;

interface ProjectConfig {
  file: string;
  directory: string;
  parsed: Pick<ts.ParsedCommandLine, "fileNames" | "options">;
}

const sourceExtensions = /\.(?:[cm]?[jt]sx?)$/i;
const excludedDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

function readProjectConfigs(root: string): ProjectConfig[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(absolute);
      } else if (
        entry.isFile() &&
        /^(?:tsconfig|jsconfig)\.json$/.test(entry.name)
      ) {
        files.push(absolute);
      }
    }
  };
  visit(root);

  const available = new Set(files);
  return files
    .filter((file) => {
      return (
        path.basename(file) !== "jsconfig.json" ||
        !available.has(path.join(path.dirname(file), "tsconfig.json"))
      );
    })
    .flatMap((file) => {
      const read = ts.readConfigFile(file, ts.sys.readFile);
      if (read.error) return [];
      const directory = path.dirname(file);
      return [
        {
          file,
          directory,
          parsed: ts.parseJsonConfigFileContent(
            read.config,
            ts.sys,
            directory,
            { allowJs: true, checkJs: false },
            file
          ),
        },
      ];
    });
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) visit(absolute);
      } else if (entry.isFile() && sourceExtensions.test(entry.name)) {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files;
}

function relativeFile(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return undefined;
  return relative.split(path.sep).join("/");
}

function projectFile(root: string, file: string): string | undefined {
  const relative = relativeFile(root, file);
  if (relative?.split("/").includes("node_modules")) return undefined;
  return relative;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name))
    return name.text;
  return undefined;
}

function containingClassName(node: ts.Node): string | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isClassDeclaration(parent) || ts.isClassExpression(parent))
      return parent.name?.text;
  }
  return undefined;
}

function functionName(
  node: ts.FunctionLikeDeclaration,
  source: ts.SourceFile
): string {
  if (
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
    node.name
  )
    return node.name.text;

  if (ts.isConstructorDeclaration(node)) {
    const owner = containingClassName(node);
    return owner ? `${owner}.constructor` : "constructor";
  }

  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const member = propertyName(node.name);
    const owner = containingClassName(node);
    return member ? (owner ? `${owner}.${member}` : member) : `<anonymous>`;
  }

  const parent = node.parent;
  if (
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertyAssignment(parent)) &&
    ts.isIdentifier(parent.name)
  )
    return parent.name.text;

  const line =
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return `<anonymous@${line}>`;
}

function isFunctionWithBody(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    Boolean(node.body)
  );
}

function normalizeEntryFile(root: string, file: string): string | undefined {
  if (path.isAbsolute(file)) return undefined;
  const normalized = path.posix.normalize(file.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  const absolute = path.resolve(root, normalized);
  return relativeFile(root, absolute);
}

export function buildCallGraph(options: CallGraphOptions): CallGraph {
  const root = path.resolve(options.root);
  if (!existsSync(root)) return { functions: [], calls: [] };

  const defaultOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const configs = readProjectConfigs(root);
  const hasRootConfig = configs.some((config) => config.directory === root);
  const contexts: ProjectConfig[] = configs.length
    ? configs
    : [
        {
          file: root,
          directory: root,
          parsed: { fileNames: sourceFiles(root), options: defaultOptions },
        },
      ];
  if (configs.length && !hasRootConfig) {
    const configuredFiles = new Set(
      configs.flatMap((config) =>
        config.parsed.fileNames.map((file) => path.resolve(file))
      )
    );
    const unconfiguredFiles = sourceFiles(root).filter(
      (file) => !configuredFiles.has(path.resolve(file))
    );
    if (unconfiguredFiles.length) {
      contexts.push({
        file: root,
        directory: root,
        parsed: { fileNames: unconfiguredFiles, options: defaultOptions },
      });
    }
  }
  const owners = new Map<string, ProjectConfig>();
  const ownerDepth = new Map<string, number>();
  for (const config of contexts) {
    for (const file of config.parsed.fileNames) {
      if (!sourceExtensions.test(file)) continue;
      const relative = relativeFile(root, path.resolve(file));
      if (!relative) continue;
      const depth = path
        .relative(root, config.directory)
        .split(path.sep).length;
      if ((ownerDepth.get(relative) ?? -1) > depth) continue;
      ownerDepth.set(relative, depth);
      owners.set(relative, config);
    }
  }
  const programs = contexts.map((config) => {
    const compilerOptions = { ...defaultOptions, ...config.parsed.options };
    const program = ts.createProgram({
      rootNames: config.parsed.fileNames.filter((file) =>
        sourceExtensions.test(file)
      ),
      options: compilerOptions,
    });
    return { config, program, checker: program.getTypeChecker() };
  });
  const records: FunctionRecord[] = [];
  const recordsById = new Map<string, FunctionRecord>();
  const nodesByProgram = new Map<
    (typeof programs)[number],
    Map<ts.Node, FunctionRecord>
  >();
  for (const context of programs) {
    const byNode = new Map<ts.Node, FunctionRecord>();
    nodesByProgram.set(context, byNode);
    for (const source of context.program.getSourceFiles()) {
      if (source.isDeclarationFile || !projectFile(root, source.fileName))
        continue;
      const visit = (node: ts.Node) => {
        if (isFunctionWithBody(node)) {
          const file = projectFile(root, source.fileName);
          if (file) {
            const start = node.getStart(source);
            const position = source.getLineAndCharacterOfPosition(start);
            const name = functionName(node, source);
            const record: FunctionRecord = {
              id: `${file}:${position.line + 1}:${position.character + 1}:${name}`,
              name,
              file,
              line: position.line + 1,
            };
            recordsById.set(record.id, record);
            byNode.set(node, record);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  records.push(...recordsById.values());
  const edges: CallGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  for (const context of programs) {
    const byNode = nodesByProgram.get(context)!;
    const recordForDeclaration = (declaration: ts.Declaration | undefined) => {
      if (!declaration) return undefined;
      const direct = byNode.get(declaration);
      if (direct) return recordsById.get(direct.id);
      const symbol = (declaration as ts.NamedDeclaration).name
        ? context.checker.getSymbolAtLocation(
            (declaration as ts.NamedDeclaration).name!
          )
        : undefined;
      return symbol?.declarations
        ?.map((item) => byNode.get(item))
        .find(Boolean);
    };
    for (const source of context.program.getSourceFiles()) {
      const sourcePath = projectFile(root, source.fileName);
      if (
        source.isDeclarationFile ||
        !sourcePath ||
        owners.get(sourcePath) !== context.config
      )
        continue;
      const visit = (node: ts.Node, current?: FunctionRecord) => {
        let owner = current;
        if (isFunctionWithBody(node)) {
          const local = byNode.get(node);
          owner = local ? recordsById.get(local.id) : current;
        }

        if (owner && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
          const signature = context.checker.getResolvedSignature(node);
          let target = recordForDeclaration(signature?.getDeclaration());
          if (!target) {
            const expression = node.expression;
            let symbol = context.checker.getSymbolAtLocation(expression);
            if (symbol && symbol.flags & ts.SymbolFlags.Alias)
              symbol = context.checker.getAliasedSymbol(symbol);
            target = symbol?.declarations
              ?.map((declaration) => recordForDeclaration(declaration))
              .find(Boolean);
          }
          if (target) {
            const line =
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1;
            const file = sourcePath;
            const kind = ts.isNewExpression(node) ? "construct" : "call";
            const key = `${owner.id}\0${target.id}\0${file}\0${line}\0${kind}`;
            if (!edgeKeys.has(key)) {
              edgeKeys.add(key);
              edges.push({
                from: owner.id,
                to: target.id,
                file,
                line,
                kind,
              });
            }
          }
        }

        ts.forEachChild(node, (child) => visit(child, owner));
      };
      visit(source);
    }
  }

  const entryFile = options.entryFile
    ? normalizeEntryFile(root, options.entryFile)
    : undefined;
  const hasFilter = Boolean(options.entryFile || options.functionName);
  const selected = hasFilter
    ? records.filter(
        (record) =>
          (!options.entryFile || record.file === entryFile) &&
          (!options.functionName || record.name === options.functionName)
      )
    : [];
  if (hasFilter && selected.length === 0) return { functions: [], calls: [] };

  let selectedIds: Set<string>;
  let selectedEdges: CallGraphEdge[];
  if (!hasFilter) {
    selectedIds = new Set(records.map((record) => record.id));
    selectedEdges = edges;
  } else {
    selectedIds = new Set(selected.map((record) => record.id));
    selectedEdges = [];
    for (let cursor = 0; cursor < selected.length; cursor += 1) {
      const current = selected[cursor]!;
      for (const edge of edges) {
        if (edge.from !== current.id) continue;
        selectedEdges.push(edge);
        if (!selectedIds.has(edge.to)) {
          selectedIds.add(edge.to);
          const target = records.find((record) => record.id === edge.to);
          if (target) selected.push(target);
        }
      }
    }
  }

  const functions = records
    .filter((record) => selectedIds.has(record.id))
    .map(({ id, name, file, line }) => ({ id, name, file, line }))
    .sort(
      (left, right) =>
        left.file.localeCompare(right.file) ||
        left.line - right.line ||
        left.name.localeCompare(right.name)
    );
  const calls = selectedEdges.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to)
  );
  return { functions, calls };
}
