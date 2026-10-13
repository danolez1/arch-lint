import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "./files";
import { matchesAny, matchesPattern } from "./paths";
import type {
  ProjectContext,
  ProjectRule,
  ResolvedConfig,
  Violation,
} from "./types";

export interface ImportEdge {
  from: string;
  to: string;
  line: number;
  typeOnly: boolean;
  sideEffect?: boolean;
}

export interface ProjectGraph {
  files: string[];
  edges: ImportEdge[];
  cycles: string[][];
  externalImports?: ExternalImport[];
}

export interface ExternalImport {
  from: string;
  package: string;
  line: number;
  sideEffect: boolean;
}

export interface ArchitectureMetrics {
  files: Array<{ file: string; fanIn: number; fanOut: number }>;
  layers: Array<{
    layer: string;
    Ca: number;
    Ce: number;
    I: number;
    A: number;
    D: number;
    team?: string;
  }>;
  teamMismatch: {
    crossTeamDependencies: number;
    ownedDependencies: number;
    ratio: number;
    byLayer: Array<{
      layer: string;
      team: string;
      crossTeamDependencies: number;
      ownedDependencies: number;
      ratio: number;
    }>;
  };
}

const extensions = ARCHITECTURE_SOURCE_EXTENSIONS.filter(
  (extension) => extension !== ".dart"
);
const parsedCache = new Map<
  string,
  {
    text: string;
    resolutionSignature: string;
    imports: Array<{
      source: string;
      line: number;
      typeOnly: boolean;
      sideEffect: boolean;
      resolutionMode: "import" | "require";
    }>;
  }
>();
const edgeCache = new Map<
  string,
  {
    signature: string;
    edges: ImportEdge[];
    externalImports: ExternalImport[];
  }
>();
const findingCache = new Map<
  string,
  { signature: string; findings: Violation[] }
>();

function sourceKind(file: string): ts.ScriptKind {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:m|c)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function importsIn(
  file: string,
  text: string,
  options: ts.CompilerOptions,
  impliedNodeFormat: ts.ResolutionMode
) {
  const resolutionSignature = JSON.stringify({
    module: options.module,
    moduleResolution: options.moduleResolution,
    impliedNodeFormat,
  });
  const cached = parsedCache.get(file);
  if (
    cached?.text === text &&
    cached.resolutionSignature === resolutionSignature
  )
    return cached.imports;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    sourceKind(file)
  );
  source.impliedNodeFormat = impliedNodeFormat;
  const imports: Array<{
    source: string;
    line: number;
    typeOnly: boolean;
    sideEffect: boolean;
    resolutionMode: "import" | "require";
  }> = [];
  const add = (
    specifier: ts.Expression,
    node: ts.Node,
    typeOnly = false,
    sideEffect = false,
    resolutionMode: "import" | "require" = "import"
  ) => {
    if (ts.isStringLiteralLike(specifier)) {
      imports.push({
        source: specifier.text,
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        typeOnly,
        sideEffect,
        resolutionMode,
      });
    }
  };
  const isTypeOnlyImport = (clause: ts.ImportClause | undefined) =>
    Boolean(
      clause?.isTypeOnly ||
      (!clause?.name &&
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly))
    );
  const isTypeOnlyExport = (declaration: ts.ExportDeclaration) =>
    Boolean(
      declaration.isTypeOnly ||
      (declaration.exportClause &&
        ts.isNamedExports(declaration.exportClause) &&
        declaration.exportClause.elements.length > 0 &&
        declaration.exportClause.elements.every(
          (element) => element.isTypeOnly
        ))
    );
  const staticResolutionMode = (specifier: ts.Expression) =>
    ts.isStringLiteralLike(specifier) &&
    ts.getModeForUsageLocation(source, specifier, options) ===
      ts.ModuleKind.CommonJS
      ? "require"
      : "import";
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) {
        const typeOnly = ts.isImportDeclaration(node)
          ? isTypeOnlyImport(node.importClause)
          : isTypeOnlyExport(node);
        add(
          node.moduleSpecifier,
          node,
          typeOnly,
          ts.isImportDeclaration(node) && node.importClause === undefined,
          staticResolutionMode(node.moduleSpecifier)
        );
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      if (node.moduleReference.expression)
        add(
          node.moduleReference.expression,
          node,
          node.isTypeOnly,
          false,
          "require"
        );
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      add(
        node.argument.literal,
        node,
        true,
        false,
        staticResolutionMode(node.argument.literal)
      );
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const isDynamic = expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire =
        ts.isIdentifier(expression) && expression.text === "require";
      if ((isDynamic || isRequire) && node.arguments.length === 1)
        add(
          node.arguments[0]!,
          node,
          false,
          false,
          isRequire ? "require" : "import"
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  parsedCache.set(file, { text, resolutionSignature, imports });
  return imports;
}

interface CompilerSettings {
  options: ts.CompilerOptions;
  files: string[];
  optionsByFile: Map<string, ts.CompilerOptions>;
}

interface WorkspacePackage {
  directory: string;
  name?: string;
  moduleType?: string;
  display: string;
  exports?: unknown;
  entryPoints: string[];
  dependencies: string[];
}

function compilerSettings(
  ctx: Pick<ProjectContext, "root" | "read"> &
    Partial<Pick<ProjectContext, "listFiles" | "listFilesOutsideScan">>
): CompilerSettings {
  const files = new Set<string>();
  const listedFiles =
    ctx.listFilesOutsideScan?.(".") ?? ctx.listFiles?.() ?? [];
  const available = new Set(listedFiles);
  for (const config of ["tsconfig.json", "jsconfig.json"])
    if (ctx.read(config) !== null) available.add(config);
  const configNames = [...available]
    .filter((file) => /(?:^|\/)(?:tsconfig|jsconfig)\.json$/.test(file))
    .filter((file) => {
      if (path.posix.basename(file) !== "jsconfig.json") return true;
      return !available.has(`${path.posix.dirname(file)}/tsconfig.json`);
    })
    .sort((left, right) => left.localeCompare(right));
  const parsedConfigs = configNames.flatMap((configName) => {
    if (ctx.read(configName) === null) return [];
    const host: ts.ParseConfigFileHost = {
      ...ts.sys,
      readFile(fileName) {
        const relative = path
          .relative(ctx.root, fileName)
          .split(path.sep)
          .join("/");
        const text = ctx.read(relative);
        if (text !== null) files.add(relative);
        return text ?? ts.sys.readFile(fileName);
      },
      fileExists(fileName) {
        const relative = path
          .relative(ctx.root, fileName)
          .split(path.sep)
          .join("/");
        return ctx.read(relative) !== null || ts.sys.fileExists(fileName);
      },
      readDirectory(rootDir, extensionsToRead, excludes, includes, depth) {
        const rootDirectory = path.resolve(rootDir);
        const includePatterns = includes.length ? includes : ["**/*"];
        const excludePatterns = excludes ?? [];
        return listedFiles
          .filter((file) => {
            const absolute = path.resolve(ctx.root, file);
            const withinProject = path
              .relative(ctx.root, absolute)
              .split(path.sep)
              .join("/");
            if (
              withinProject === ".." ||
              withinProject.startsWith("../") ||
              path.isAbsolute(withinProject)
            )
              return false;
            const relative = path
              .relative(rootDirectory, absolute)
              .split(path.sep)
              .join("/");
            if (
              extensionsToRead.length > 0 &&
              !extensionsToRead.some((extension) =>
                relative.endsWith(extension)
              )
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
      {},
      host
    );
    return parsed
      ? [{ configName, options: parsed.options, fileNames: parsed.fileNames }]
      : [];
  });
  const rootConfig =
    parsedConfigs.find(({ configName }) => configName === "tsconfig.json") ??
    parsedConfigs.find(({ configName }) => configName === "jsconfig.json");
  const optionsByFile = new Map<string, ts.CompilerOptions>();
  const optionOwners = new Map<string, number>();
  for (const { configName, options, fileNames } of parsedConfigs) {
    const directory = path.posix.dirname(configName);
    const depth = directory === "." ? 0 : directory.split("/").length;
    for (const fileName of fileNames) {
      const relative = path
        .relative(ctx.root, path.resolve(fileName))
        .split(path.sep)
        .join("/");
      if (
        relative === ".." ||
        relative.startsWith("../") ||
        path.isAbsolute(relative)
      )
        continue;
      if ((optionOwners.get(relative) ?? -1) >= depth) continue;
      optionOwners.set(relative, depth);
      optionsByFile.set(relative, options);
    }
  }
  return {
    options: rootConfig?.options ?? {},
    files: [...files].sort(),
    optionsByFile,
  };
}

export function graphConfigFiles(
  root: string,
  read: (file: string) => string | null,
  listedFiles: string[] = []
): string[] {
  return compilerSettings({ root, read, listFiles: () => listedFiles }).files;
}

function aliasTargets(
  specifier: string,
  options: ts.CompilerOptions,
  root: string
): string[] {
  const paths = options.paths ?? {};
  const base =
    options.baseUrl ??
    (typeof options.pathsBasePath === "string" ? options.pathsBasePath : root);
  const targets: string[] = [];
  const matching = Object.entries(paths)
    .map(([pattern, values]) => {
      const star = pattern.indexOf("*");
      return {
        pattern,
        values,
        prefix: star < 0 ? pattern : pattern.slice(0, star),
        suffix: star < 0 ? "" : pattern.slice(star + 1),
        exact: star < 0,
      };
    })
    .filter(({ pattern, prefix, suffix, exact }) =>
      exact
        ? specifier === pattern
        : specifier.startsWith(prefix) && specifier.endsWith(suffix)
    )
    .sort(
      (left, right) =>
        right.prefix.length - left.prefix.length ||
        right.suffix.length - left.suffix.length
    )[0];
  if (matching) {
    const { values, prefix, suffix } = matching;
    const middle = specifier.slice(
      prefix.length,
      specifier.length - suffix.length || undefined
    );
    for (const value of values)
      targets.push(path.resolve(base, value.replace("*", middle)));
  }
  if (options.baseUrl && !specifier.startsWith("."))
    targets.push(path.resolve(options.baseUrl, specifier));
  return targets;
}

function packageManifestPaths(files: string[]): string[] {
  const manifests = new Set<string>();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (directory !== ".") {
      manifests.add(`${directory}/package.json`);
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    manifests.add("package.json");
  }
  return [...manifests].sort();
}

function enclosingPackageSignature(
  root: string,
  files: string[],
  read: (file: string) => string | null
): string {
  const manifests = new Set<string>();
  for (const file of files) {
    let directory = path.dirname(path.resolve(root, file));
    while (true) {
      const manifest = path.join(directory, "package.json");
      const relative = path.relative(root, manifest).split(path.sep).join("/");
      const text = read(relative);
      if (text !== null) manifests.add(`${relative}\0${text}`);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...manifests].sort().join("\0");
}

export function graphEnclosingPackageManifestFiles(
  root: string,
  files: string[]
): string[] {
  const manifests = new Set<string>();
  for (const file of files) {
    let directory = path.dirname(path.resolve(root, file));
    while (true) {
      const manifest = path.join(directory, "package.json");
      const relative = path.relative(root, manifest).split(path.sep).join("/");
      if (relative === ".." || relative.startsWith("../"))
        manifests.add(manifest);
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return [...manifests].sort();
}

function workspacePackages(
  files: string[],
  read: (file: string) => string | null
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const manifest of packageManifestPaths(files)) {
    const text = read(manifest);
    if (text === null) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      continue;
    }
    const directory = path.posix.dirname(manifest);
    const name =
      typeof parsed.name === "string" && parsed.name.trim()
        ? parsed.name
        : undefined;
    const entryPoints = [
      parsed.types,
      parsed.typings,
      parsed.source,
      parsed.module,
      parsed.main,
    ].filter((entry): entry is string => typeof entry === "string");
    packages.push({
      directory,
      name,
      moduleType: typeof parsed.type === "string" ? parsed.type : undefined,
      display: name ?? directory,
      exports: parsed.exports,
      entryPoints,
      dependencies: [
        parsed.dependencies,
        parsed.devDependencies,
        parsed.optionalDependencies,
        parsed.peerDependencies,
      ].flatMap((value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.keys(value as Record<string, unknown>)
          : []
      ),
    });
  }
  return packages.sort((a, b) => a.directory.localeCompare(b.directory));
}

function collectExportTargets(
  value: unknown,
  mode: "import" | "require"
): string[] {
  if (typeof value === "string") return value.startsWith("./") ? [value] : [];
  if (Array.isArray(value))
    return value.flatMap((entry) => collectExportTargets(entry, mode));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const priority =
    mode === "require"
      ? ["types", "source", "require", "node", "default", "import", "module"]
      : ["types", "source", "import", "module", "node", "default", "require"];
  return Object.keys(record)
    .filter(
      (key) =>
        !(
          (mode === "import" && key === "require") ||
          (mode === "require" && key === "import")
        )
    )
    .sort((a, b) => {
      const aPriority = priority.indexOf(a);
      const bPriority = priority.indexOf(b);
      if (aPriority < 0 && bPriority < 0) return a.localeCompare(b);
      if (aPriority < 0) return 1;
      if (bPriority < 0) return -1;
      return aPriority - bPriority;
    })
    .flatMap((key) => collectExportTargets(record[key], mode));
}

function packageExportTargets(
  exports: unknown,
  subpath: string,
  mode: "import" | "require"
): string[] | null {
  if (typeof exports === "string" || Array.isArray(exports))
    return subpath === "." ? collectExportTargets(exports, mode) : null;
  if (!exports || typeof exports !== "object") return null;
  const record = exports as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.some((key) => key.startsWith(".")))
    return subpath === "." ? collectExportTargets(record, mode) : null;
  if (Object.hasOwn(record, subpath))
    return collectExportTargets(record[subpath], mode);
  for (const key of keys
    .filter((entry) => entry.includes("*"))
    .sort((a, b) => {
      const parts = (value: string) => {
        const star = value.indexOf("*");
        return [star, value.length - star - 1];
      };
      const [aPrefix, aSuffix] = parts(a);
      const [bPrefix, bSuffix] = parts(b);
      return bPrefix - aPrefix || bSuffix - aSuffix || a.localeCompare(b);
    })) {
    const star = key.indexOf("*");
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    const middle = subpath.slice(
      prefix.length,
      subpath.length - suffix.length || undefined
    );
    return collectExportTargets(record[key], mode).map((target) =>
      target.replace("*", middle)
    );
  }
  return [];
}

function workspaceTargets(
  specifier: string,
  packages: WorkspacePackage[],
  root: string,
  mode: "import" | "require"
): string[] {
  const pkg = packages
    .filter(
      (entry) =>
        entry.name !== undefined &&
        (specifier === entry.name || specifier.startsWith(`${entry.name}/`))
    )
    .sort((a, b) => (b.name?.length ?? 0) - (a.name?.length ?? 0))[0];
  if (!pkg?.name) return [];
  const subpath =
    specifier === pkg.name ? "." : `./${specifier.slice(pkg.name.length + 1)}`;
  let targets: string[];
  if (pkg.exports !== undefined) {
    targets = packageExportTargets(pkg.exports, subpath, mode) ?? [];
  } else if (subpath !== ".") {
    targets = [subpath];
  } else {
    targets = [
      ...pkg.entryPoints.map((entry) =>
        entry.startsWith("./") ? entry : `./${entry}`
      ),
      "./src/index.ts",
      "./src/index.js",
      "./index.ts",
      "./index.js",
    ];
  }
  return targets.map((target) => path.resolve(root, pkg.directory, target));
}

function externalPackageName(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("node:")
  )
    return null;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : null;
  }
  return specifier.split("/")[0] || null;
}

function workspacePackageForFile(
  file: string,
  packages: WorkspacePackage[]
): WorkspacePackage | undefined {
  let selected: WorkspacePackage | undefined;
  for (const pkg of packages)
    if (
      (pkg.directory === "." || file.startsWith(`${pkg.directory}/`)) &&
      (!selected || pkg.directory.length > selected.directory.length)
    )
      selected = pkg;
  return selected;
}

function candidates(base: string): string[] {
  const out = [base];
  const sourceSubstitutions: Record<string, string[]> = {
    ".js": [".ts", ".tsx", ".js", ".jsx"],
    ".jsx": [".tsx", ".jsx"],
    ".mjs": [".mts", ".mjs"],
    ".cjs": [".cts", ".cjs"],
  };
  const extension = path.extname(base);
  if (sourceSubstitutions[extension]) {
    const stem = base.slice(0, -extension.length);
    for (const replacement of sourceSubstitutions[extension]!)
      out.push(`${stem}${replacement}`);
  }
  for (const ext of extensions) out.push(`${base}${ext}`);
  for (const ext of extensions) out.push(path.join(base, `index${ext}`));
  return out;
}

function resolveImport(
  from: string,
  specifier: string,
  root: string,
  known: Set<string>,
  options: ts.CompilerOptions,
  packages: WorkspacePackage[],
  mode: "import" | "require"
): string | null {
  const targets = specifier.startsWith(".")
    ? [path.resolve(root, path.dirname(from), specifier)]
    : [
        ...aliasTargets(specifier, options, root),
        ...workspaceTargets(specifier, packages, root, mode),
      ];
  for (const target of targets) {
    for (const candidate of candidates(target)) {
      const rel = path.relative(root, candidate).split(path.sep).join("/");
      if (known.has(rel)) return rel;
    }
  }
  return null;
}

function stronglyConnected(files: string[], edges: ImportEdge[]): string[][] {
  const next = new Map(files.map((file) => [file, [] as string[]]));
  const previous = new Map(files.map((file) => [file, [] as string[]]));
  const selfLoops = new Set<string>();
  for (const edge of edges) {
    if (edge.from === edge.to) {
      selfLoops.add(edge.from);
      continue;
    }
    next.get(edge.from)?.push(edge.to);
    previous.get(edge.to)?.push(edge.from);
  }
  const seen = new Set<string>();
  const order: string[] = [];
  for (const root of files) {
    if (seen.has(root)) continue;
    const stack: Array<{ file: string; index: number }> = [
      { file: root, index: 0 },
    ];
    seen.add(root);
    while (stack.length) {
      const frame = stack[stack.length - 1]!;
      const targets = next.get(frame.file) ?? [];
      if (frame.index < targets.length) {
        const target = targets[frame.index++]!;
        if (!seen.has(target)) {
          seen.add(target);
          stack.push({ file: target, index: 0 });
        }
      } else {
        order.push(frame.file);
        stack.pop();
      }
    }
  }
  seen.clear();
  const groups: string[][] = [];
  for (let i = order.length - 1; i >= 0; i--) {
    const root = order[i]!;
    if (seen.has(root)) continue;
    const group: string[] = [];
    const stack = [root];
    seen.add(root);
    while (stack.length) {
      const file = stack.pop()!;
      group.push(file);
      for (const source of previous.get(file) ?? []) {
        if (!seen.has(source)) {
          seen.add(source);
          stack.push(source);
        }
      }
    }
    if (group.length > 1 || selfLoops.has(group[0]!)) groups.push(group.sort());
  }
  return groups.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

function buildProjectGraphWithSettings(
  ctx: ProjectContext,
  settings: CompilerSettings,
  includeTests = false
): ProjectGraph {
  const scannedFiles = ctx.listFiles(extensions);
  const externalTestFiles = includeTests
    ? (ctx.listFilesOutsideScan?.(".") ?? []).filter(
        (file) =>
          extensions.some((extension) => file.endsWith(extension)) &&
          matchesAny(file, ctx.config.tests)
      )
    : [];
  const listedFiles = [...scannedFiles, ...externalTestFiles];
  const files = [...new Set(listedFiles)]
    .filter(
      (file) =>
        !/\.d\.(?:ts|mts|cts)$/.test(file) &&
        (includeTests || !matchesAny(file, ctx.config.tests))
    )
    .sort();
  const known = new Set(files);
  const options = settings.options;
  const optionsForFile = (file: string) =>
    settings.optionsByFile.get(file) ?? options;
  const packages = workspacePackages(files, ctx.read);
  const moduleManifestSignature = enclosingPackageSignature(
    ctx.root,
    files,
    ctx.read
  );
  const moduleResolutionHost: ts.ModuleResolutionHost = {
    fileExists(fileName) {
      const relative = path
        .relative(ctx.root, fileName)
        .split(path.sep)
        .join("/");
      return ctx.read(relative) !== null;
    },
    readFile(fileName) {
      const relative = path
        .relative(ctx.root, fileName)
        .split(path.sep)
        .join("/");
      return ctx.read(relative) ?? undefined;
    },
  };
  const edges: ImportEdge[] = [];
  const externalImports: ExternalImport[] = [];
  const knownAbsolute = new Set(files.map((file) => path.join(ctx.root, file)));
  const graphSignature = createHash("sha256")
    .update(files.join("\0"))
    .update(JSON.stringify(options))
    .update(
      JSON.stringify(
        [...settings.optionsByFile].sort(([left], [right]) =>
          left.localeCompare(right)
        )
      )
    )
    .update(JSON.stringify(packages))
    .update(moduleManifestSignature)
    .update(String(includeTests))
    .digest("hex");
  for (const file of files) {
    const text = ctx.read(file);
    if (text === null) continue;
    const absolute = path.join(ctx.root, file);
    const signature = createHash("sha256")
      .update(graphSignature)
      .update(text)
      .digest("hex");
    const cached = edgeCache.get(absolute);
    let sourceEdges: ImportEdge[];
    let sourceExternalImports: ExternalImport[];
    if (cached?.signature === signature) {
      sourceEdges = cached.edges;
      sourceExternalImports = cached.externalImports;
    } else {
      sourceEdges = [];
      sourceExternalImports = [];
      const fileOptions = optionsForFile(file);
      const impliedNodeFormat = ts.getImpliedNodeFormatForFile(
        absolute,
        undefined,
        moduleResolutionHost,
        fileOptions
      );
      for (const item of importsIn(
        absolute,
        text,
        fileOptions,
        impliedNodeFormat
      )) {
        const to = resolveImport(
          file,
          item.source,
          ctx.root,
          known,
          fileOptions,
          packages,
          item.resolutionMode
        );
        if (to) {
          sourceEdges.push({
            from: file,
            to,
            line: item.line,
            typeOnly: item.typeOnly,
            sideEffect: item.sideEffect,
          });
          continue;
        }
        const importedPackage = externalPackageName(item.source);
        const owner = workspacePackageForFile(file, packages);
        if (
          importedPackage &&
          owner?.dependencies.includes(importedPackage) &&
          !packages.some((pkg) => pkg.name === importedPackage)
        )
          sourceExternalImports.push({
            from: file,
            package: importedPackage,
            line: item.line,
            sideEffect: item.sideEffect,
          });
      }
      edgeCache.set(absolute, {
        signature,
        edges: sourceEdges,
        externalImports: sourceExternalImports,
      });
    }
    edges.push(...sourceEdges);
    externalImports.push(...sourceExternalImports);
  }
  for (const key of parsedCache.keys()) {
    if (key.startsWith(ctx.root) && !knownAbsolute.has(key))
      parsedCache.delete(key);
  }
  for (const key of edgeCache.keys())
    if (key.startsWith(ctx.root) && !knownAbsolute.has(key))
      edgeCache.delete(key);
  return {
    files,
    edges,
    cycles: stronglyConnected(files, edges),
    externalImports,
  };
}

export function buildProjectGraph(
  ctx: ProjectContext,
  options: { includeTests?: boolean } = {}
): ProjectGraph {
  return buildProjectGraphWithSettings(
    ctx,
    compilerSettings(ctx),
    options.includeTests ?? false
  );
}

interface AdrRules {
  layers: Record<string, string[]>;
  allows: Map<string, { file: string; line: number }>;
  denies: Map<string, { file: string; line: number }>;
}

function normalizeProjectDirectory(directory: string): string {
  const normalized = path.posix.normalize(directory.replace(/\\/g, "/"));
  return normalized.replace(/^\.\//, "").replace(/\/$/, "");
}

function parseAdrRules(ctx: ProjectContext): AdrRules {
  const layers: Record<string, string[]> = {};
  const allows = new Map<string, { file: string; line: number }>();
  const denies = new Map<string, { file: string; line: number }>();
  if (!ctx.config.adrDir) return { layers, allows, denies };
  const directory = normalizeProjectDirectory(ctx.config.adrDir);
  const prefix = directory && directory !== "." ? `${directory}/` : "";
  const files = new Set([
    ...ctx.listFiles([".md"]),
    ...(ctx.listFilesOutsideScan?.(directory || ".") ?? []),
  ]);
  for (const file of [...files]
    .filter(
      (entry) => (!prefix || entry.startsWith(prefix)) && entry.endsWith(".md")
    )
    .sort()) {
    const text = ctx.read(file) ?? "";
    const blocks = /```archlint\s*\n([\s\S]*?)```/g;
    for (const block of text.matchAll(blocks)) {
      const start = block.index ?? 0;
      const firstLine = text.slice(0, start).split("\n").length + 1;
      const lines = (block[1] ?? "").split("\n");
      lines.forEach((raw, index) => {
        const line = raw.replace(/#.*$/, "").trim();
        if (!line) return;
        const layer = line.match(/^layer\s+([\w.-]+)\s*=\s*(.+)$/);
        const edge = line.match(/^(allow|deny)\s+([\w.-]+)\s*->\s*([\w.-]+)$/);
        if (layer)
          layers[layer[1]!] = [
            ...new Set([
              ...(layers[layer[1]!] ?? []),
              ...layer[2]!
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean),
            ]),
          ];
        if (edge)
          (edge[1] === "allow" ? allows : denies).set(
            `${edge[2]}->${edge[3]}`,
            { file, line: firstLine + index }
          );
      });
    }
  }
  return { layers, allows, denies };
}

function mergeAdrLayers(config: ResolvedConfig, adr: AdrRules): ResolvedConfig {
  const layers = { ...config.layers };
  for (const [name, prefixes] of Object.entries(adr.layers))
    layers[name] = [...new Set([...(layers[name] ?? []), ...prefixes])];
  return { ...config, layers };
}

export function architectureConfigWithAdrLayers(
  ctx: ProjectContext
): ResolvedConfig {
  return mergeAdrLayers(ctx.config, parseAdrRules(ctx));
}

function layerFor(file: string, config: ResolvedConfig): string | null {
  let selected: string | null = null;
  let specificity = -1;
  for (const [name, patterns] of Object.entries(config.layers)) {
    for (const pattern of patterns) {
      if (
        matchesAny(file, [pattern]) &&
        pattern.replace(/[*?{}]/g, "").length > specificity
      ) {
        selected = name;
        specificity = pattern.replace(/[*?{}]/g, "").length;
      }
    }
  }
  return selected;
}

function contextFor(
  layer: string,
  contexts: ResolvedConfig["contexts"]
): ResolvedConfig["contexts"][number] | undefined {
  return contexts.find((context) => context.layers.includes(layer));
}

function validateGraphConfig(config: ResolvedConfig): void {
  if (
    !Number.isInteger(config.graph.coChangeThreshold) ||
    config.graph.coChangeThreshold < 1
  )
    throw new Error("graph.coChangeThreshold must be a positive integer");
  const layers = new Set(Object.keys(config.layers));
  for (const [from, targets] of Object.entries(config.allowedDependencies)) {
    if (!layers.has(from))
      throw new Error(`allowedDependencies references unknown layer "${from}"`);
    for (const target of targets)
      if (!layers.has(target))
        throw new Error(
          `allowedDependencies.${from} references unknown layer "${target}"`
        );
  }
  for (const layer of config.abstractLayers)
    if (!layers.has(layer))
      throw new Error(`abstractLayers references unknown layer "${layer}"`);
  const names = new Set<string>();
  const owners = new Map<string, string>();
  for (const context of config.contexts) {
    if (names.has(context.name))
      throw new Error(`contexts contains duplicate name "${context.name}"`);
    names.add(context.name);
    for (const layer of context.layers) {
      if (!layers.has(layer))
        throw new Error(
          `contexts.${context.name} references unknown layer "${layer}"`
        );
      const owner = owners.get(layer);
      if (owners.has(layer))
        throw new Error(
          `layer "${layer}" belongs to both context "${owner}" and "${context.name}"`
        );
      owners.set(layer, context.name);
    }
    for (const layer of context.public)
      if (!context.layers.includes(layer))
        throw new Error(
          `contexts.${context.name}.public includes layer "${layer}" outside its context`
        );
  }
  const teamOwners = new Map<string, string>();
  for (const [team, ownedLayers] of Object.entries(config.teams)) {
    if (!team.trim()) throw new Error("teams contains an empty team name");
    for (const layer of ownedLayers) {
      if (!layers.has(layer))
        throw new Error(`teams.${team} references unknown layer "${layer}"`);
      const owner = teamOwners.get(layer);
      if (teamOwners.has(layer))
        throw new Error(
          `layer "${layer}" belongs to both team "${owner}" and "${team}"`
        );
      teamOwners.set(layer, team);
    }
  }
}

function addLayerMetrics(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const inCount = new Map<string, Set<string>>();
  const outCount = new Map<string, Set<string>>();
  const layerEdges: Array<{
    from: string;
    to: string;
    file: string;
    target: string;
    line: number;
  }> = [];
  for (const edge of graph.edges) {
    const from = layerFor(edge.from, config);
    const to = layerFor(edge.to, config);
    if (!from || !to || from === to) continue;
    (
      outCount.get(from) ?? (outCount.set(from, new Set()), outCount.get(from)!)
    ).add(to);
    (inCount.get(to) ?? (inCount.set(to, new Set()), inCount.get(to)!)).add(
      from
    );
    layerEdges.push({
      from,
      to,
      file: edge.from,
      target: edge.to,
      line: edge.line,
    });
  }
  const instability = (name: string) => {
    const ce = outCount.get(name)?.size ?? 0;
    const ca = inCount.get(name)?.size ?? 0;
    return ca + ce === 0 ? 0 : ce / (ca + ce);
  };
  for (const edge of layerEdges) {
    const fromI = instability(edge.from);
    const toI = instability(edge.to);
    if (fromI < toI) {
      findings.push({
        file: edge.file,
        line: edge.line,
        rule: "stable-dependencies",
        identity: `${edge.file}:${edge.line}->${edge.target}`,
        metrics: {
          instabilityGap: { value: toI - fromI, worsening: "higher" },
        },
        message: `${edge.from} (instability ${fromI.toFixed(2)}) depends on less stable ${edge.to} (instability ${toI.toFixed(2)})`,
      });
    }
  }
  const abstract = new Set(config.abstractLayers);
  for (const name of Object.keys(config.layers)) {
    const a = abstract.has(name) ? 1 : 0;
    const i = instability(name);
    const distance = Math.abs(a + i - 1);
    if (distance >= 0.8 && (inCount.has(name) || outCount.has(name))) {
      const file = graph.files.find(
        (entry) => layerFor(entry, config) === name
      );
      if (file)
        findings.push({
          file,
          line: 0,
          rule: "stability-distance",
          identity: `layer:${name}`,
          metrics: { distance: { value: distance, worsening: "higher" } },
          message: `${name} is ${distance.toFixed(2)} from the declared abstractness and instability balance`,
        });
    }
  }
}

export function architectureMetrics(
  graph: ProjectGraph,
  config: ResolvedConfig
): ArchitectureMetrics {
  validateGraphConfig(config);
  const incomingFiles = new Map(
    graph.files.map((file) => [file, new Set<string>()])
  );
  const outgoingFiles = new Map(
    graph.files.map((file) => [file, new Set<string>()])
  );
  const incomingLayers = new Map<string, Set<string>>();
  const outgoingLayers = new Map<string, Set<string>>();
  const owners = new Map<string, string>();
  for (const [team, layers] of Object.entries(config.teams))
    for (const layer of layers) owners.set(layer, team);
  const ownedEdges = new Set<string>();
  const crossTeamEdges = new Set<string>();
  const layerOwnedEdges = new Map<string, Set<string>>();
  const layerCrossTeamEdges = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    incomingFiles.get(edge.to)?.add(edge.from);
    outgoingFiles.get(edge.from)?.add(edge.to);
    const from = layerFor(edge.from, config);
    const to = layerFor(edge.to, config);
    if (!from || !to || from === to) continue;
    (
      outgoingLayers.get(from) ??
      (outgoingLayers.set(from, new Set()), outgoingLayers.get(from)!)
    ).add(to);
    (
      incomingLayers.get(to) ??
      (incomingLayers.set(to, new Set()), incomingLayers.get(to)!)
    ).add(from);
    const fromTeam = owners.get(from);
    const toTeam = owners.get(to);
    if (fromTeam === undefined || toTeam === undefined) continue;
    const key = `${edge.from}\0${edge.to}`;
    ownedEdges.add(key);
    for (const layer of [from, to]) {
      const owned = layerOwnedEdges.get(layer) ?? new Set<string>();
      owned.add(key);
      layerOwnedEdges.set(layer, owned);
    }
    if (fromTeam !== toTeam) {
      crossTeamEdges.add(key);
      for (const layer of [from, to]) {
        const crossed = layerCrossTeamEdges.get(layer) ?? new Set<string>();
        crossed.add(key);
        layerCrossTeamEdges.set(layer, crossed);
      }
    }
  }
  const instability = (layer: string) => {
    const Ca = incomingLayers.get(layer)?.size ?? 0;
    const Ce = outgoingLayers.get(layer)?.size ?? 0;
    return Ca + Ce === 0 ? 0 : Ce / (Ca + Ce);
  };
  const abstract = new Set(config.abstractLayers);
  return {
    files: graph.files.map((file) => ({
      file,
      fanIn: incomingFiles.get(file)?.size ?? 0,
      fanOut: outgoingFiles.get(file)?.size ?? 0,
    })),
    layers: Object.keys(config.layers).map((layer) => {
      const I = instability(layer);
      const A = abstract.has(layer) ? 1 : 0;
      return {
        layer,
        Ca: incomingLayers.get(layer)?.size ?? 0,
        Ce: outgoingLayers.get(layer)?.size ?? 0,
        I,
        A,
        D: Math.abs(A + I - 1),
        ...(owners.has(layer) ? { team: owners.get(layer)! } : {}),
      };
    }),
    teamMismatch: {
      crossTeamDependencies: crossTeamEdges.size,
      ownedDependencies: ownedEdges.size,
      ratio: ownedEdges.size === 0 ? 0 : crossTeamEdges.size / ownedEdges.size,
      byLayer: [...owners].map(([layer, team]) => {
        const owned = layerOwnedEdges.get(layer)?.size ?? 0;
        const crossed = layerCrossTeamEdges.get(layer)?.size ?? 0;
        return {
          layer,
          team,
          crossTeamDependencies: crossed,
          ownedDependencies: owned,
          ratio: owned === 0 ? 0 : crossed / owned,
        };
      }),
    },
  };
}

export function graphPackageManifestFiles(files: string[]): string[] {
  return packageManifestPaths(files);
}

function addPackageCycleFindings(
  ctx: ProjectContext,
  graph: ProjectGraph,
  findings: Violation[]
): void {
  const packages = workspacePackages(graph.files, ctx.read);
  const displays = new Map(packages.map((pkg) => [pkg.directory, pkg.display]));
  const sourcePackages = new Map<string, string>();
  const roots = new Set(packages.map((pkg) => pkg.directory));
  for (const file of graph.files) {
    const owner = workspacePackageForFile(file, packages);
    if (owner) sourcePackages.set(file, owner.directory);
  }
  const packageEdges: ImportEdge[] = [];
  const packageEdgeSources = new Map<string, ImportEdge>();
  for (const edge of graph.edges) {
    const from = sourcePackages.get(edge.from);
    const to = sourcePackages.get(edge.to);
    if (!from || !to || from === to) continue;
    packageEdges.push({ ...edge, from, to });
    packageEdgeSources.set(`${from}\0${to}`, edge);
  }
  for (const group of stronglyConnected([...roots].sort(), packageEdges)) {
    const members = new Set(group);
    const edge = packageEdges.find(
      (candidate) => members.has(candidate.from) && members.has(candidate.to)
    );
    const source = edge
      ? packageEdgeSources.get(`${edge.from}\0${edge.to}`)
      : undefined;
    const labels = group.map(
      (directory) => displays.get(directory) ?? directory
    );
    findings.push({
      file: source?.from ?? graph.files[0] ?? "package.json",
      line: source?.line ?? 1,
      rule: "package-circular-dependency",
      identity: `package-cycle:${group.join("|")}`,
      message: `Circular dependency between packages: ${labels.join(", ")}`,
    });
  }
}

function couplingCounts(
  graph: ProjectGraph
): Map<string, { fanIn: number; fanOut: number }> {
  const incoming = new Map(
    graph.files.map((file) => [file, new Set<string>()])
  );
  const outgoing = new Map(
    graph.files.map((file) => [file, new Set<string>()])
  );
  for (const edge of graph.edges) {
    incoming.get(edge.to)?.add(edge.from);
    outgoing.get(edge.from)?.add(edge.to);
  }
  return new Map(
    graph.files.map((file) => [
      file,
      {
        fanIn: incoming.get(file)?.size ?? 0,
        fanOut: outgoing.get(file)?.size ?? 0,
      },
    ])
  );
}

function addHubModuleFindings(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const options = config.rules["hub-module"]?.options ?? {};
  const minFanIn = options.minFanIn ?? 10;
  const minFanOut = options.minFanOut ?? 10;
  if (!Number.isInteger(minFanIn) || (minFanIn as number) < 1)
    throw new Error("hub-module minFanIn must be a positive integer");
  if (!Number.isInteger(minFanOut) || (minFanOut as number) < 1)
    throw new Error("hub-module minFanOut must be a positive integer");
  for (const [file, { fanIn, fanOut }] of couplingCounts(graph)) {
    if (fanIn < (minFanIn as number) || fanOut < (minFanOut as number))
      continue;
    findings.push({
      file,
      line: 1,
      rule: "hub-module",
      identity: `hub:${file}`,
      metrics: {
        fanIn: { value: fanIn, worsening: "higher" },
        fanOut: { value: fanOut, worsening: "higher" },
      },
      message: `${file} is a dependency hub with fan-in ${fanIn} and fan-out ${fanOut}`,
    });
  }
}

function addHighCouplingFindings(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const options = config.rules["high-coupling"]?.options ?? {};
  const maxFanIn = options.maxFanIn ?? 20;
  const maxFanOut = options.maxFanOut ?? 10;
  if (!Number.isInteger(maxFanIn) || (maxFanIn as number) < 1)
    throw new Error("high-coupling maxFanIn must be a positive integer");
  if (!Number.isInteger(maxFanOut) || (maxFanOut as number) < 1)
    throw new Error("high-coupling maxFanOut must be a positive integer");
  for (const [file, { fanIn, fanOut }] of couplingCounts(graph)) {
    if (fanIn <= (maxFanIn as number) && fanOut <= (maxFanOut as number))
      continue;
    findings.push({
      file,
      line: 1,
      rule: "high-coupling",
      identity: `coupling:${file}`,
      metrics: {
        fanIn: { value: fanIn, worsening: "higher" },
        fanOut: { value: fanOut, worsening: "higher" },
      },
      message: `${file} exceeds coupling limits with fan-in ${fanIn} (max ${maxFanIn}) and fan-out ${fanOut} (max ${maxFanOut})`,
    });
  }
}

function addHubDependencyFindings(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const maxImporters =
    config.rules["hub-dependency"]?.options?.maxImporters ?? 10;
  if (!Number.isInteger(maxImporters) || (maxImporters as number) < 1)
    throw new Error("hub-dependency maxImporters must be a positive integer");
  const importers = new Map<string, Set<string>>();
  const firstImport = new Map<string, ExternalImport>();
  for (const entry of graph.externalImports ?? []) {
    const files = importers.get(entry.package) ?? new Set<string>();
    files.add(entry.from);
    importers.set(entry.package, files);
    if (!firstImport.has(entry.package)) firstImport.set(entry.package, entry);
  }
  for (const [name, files] of importers) {
    if (files.size <= (maxImporters as number)) continue;
    const source = firstImport.get(name)!;
    findings.push({
      file: source.from,
      line: source.line,
      rule: "hub-dependency",
      identity: `hub-dependency:${name}`,
      metrics: { importers: { value: files.size, worsening: "higher" } },
      message: `External dependency ${name} is imported by ${files.size} files, above the limit of ${maxImporters}`,
    });
  }
}

function addVendorCouplingFindings(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const options = config.rules["vendor-coupling"]?.options ?? {};
  const maxLayers = options.maxLayers === undefined ? 1 : options.maxLayers;
  const ignored = options.ignore === undefined ? [] : options.ignore;
  if (!Number.isInteger(maxLayers) || (maxLayers as number) < 1)
    throw new Error("vendor-coupling maxLayers must be a positive integer");
  if (
    !Array.isArray(ignored) ||
    ignored.some((name) => typeof name !== "string")
  )
    throw new Error("vendor-coupling ignore must be an array of package names");
  const locations = new Map<string, Map<string, ExternalImport>>();
  for (const entry of graph.externalImports ?? []) {
    if ((ignored as string[]).includes(entry.package)) continue;
    const layer = layerFor(entry.from, config);
    if (!layer) continue;
    const byLayer = locations.get(entry.package) ?? new Map();
    if (!byLayer.has(layer)) byLayer.set(layer, entry);
    locations.set(entry.package, byLayer);
  }
  for (const [name, byLayer] of locations) {
    if (byLayer.size <= (maxLayers as number)) continue;
    const source = [...byLayer.values()].sort((left, right) =>
      left.from.localeCompare(right.from)
    )[0]!;
    findings.push({
      file: source.from,
      line: source.line,
      rule: "vendor-coupling",
      identity: `vendor-coupling:${name}`,
      metrics: { layers: { value: byLayer.size, worsening: "higher" } },
      message: `External dependency ${name} is imported across ${byLayer.size} architectural layers (max ${maxLayers}); add a project-owned adapter or narrow its use`,
    });
  }
}

function addMaxInstabilityFindings(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const configuredMaximum = config.rules["max-instability"]?.options?.max;
  const maximum = configuredMaximum === undefined ? 0.8 : configuredMaximum;
  if (
    typeof maximum !== "number" ||
    !Number.isFinite(maximum) ||
    maximum < 0 ||
    maximum > 1
  )
    throw new Error("max-instability max must be between 0 and 1");
  for (const { layer, I } of architectureMetrics(graph, config).layers) {
    if (I <= maximum) continue;
    const file = graph.files.find(
      (candidate) => layerFor(candidate, config) === layer
    );
    if (!file) continue;
    findings.push({
      file,
      line: 1,
      rule: "max-instability",
      identity: `max-instability:${layer}`,
      metrics: { instability: { value: I, worsening: "higher" } },
      message: `${layer} has instability ${I.toFixed(2)}, above the maximum ${maximum}`,
    });
  }
}

function addTeamMismatchFindings(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const configuredMaximum = config.rules["team-mismatch"]?.options?.maxRatio;
  const maximum = configuredMaximum === undefined ? 0.5 : configuredMaximum;
  if (
    typeof maximum !== "number" ||
    !Number.isFinite(maximum) ||
    maximum < 0 ||
    maximum > 1
  )
    throw new Error("team-mismatch maxRatio must be between 0 and 1");
  for (const metric of architectureMetrics(graph, config).teamMismatch
    .byLayer) {
    if (metric.ownedDependencies === 0 || metric.ratio <= maximum) continue;
    const file = graph.files.find(
      (candidate) => layerFor(candidate, config) === metric.layer
    );
    if (!file) continue;
    findings.push({
      file,
      line: 1,
      rule: "team-mismatch",
      identity: `team-mismatch:${metric.layer}`,
      metrics: { ratio: { value: metric.ratio, worsening: "higher" } },
      message: `${metric.layer} (${metric.team}) crosses team ownership on ${metric.crossTeamDependencies}/${metric.ownedDependencies} incident dependencies (${Math.round(metric.ratio * 100)}%), above the maximum ${Math.round(maximum * 100)}%`,
    });
  }
}

function addSideEffectImportFindings(
  graph: ProjectGraph,
  findings: Violation[]
): void {
  for (const edge of graph.edges) {
    if (!edge.sideEffect) continue;
    findings.push({
      file: edge.from,
      line: edge.line,
      rule: "side-effect-import",
      identity: `side-effect-import:${edge.from}:${edge.line}:${edge.to}`,
      message: `${edge.from} imports ${edge.to} only for its module side effects`,
    });
  }
  for (const entry of graph.externalImports ?? []) {
    if (!entry.sideEffect) continue;
    findings.push({
      file: entry.from,
      line: entry.line,
      rule: "side-effect-import",
      identity: `side-effect-import:${entry.from}:${entry.line}:${entry.package}`,
      message: `${entry.from} imports external dependency ${entry.package} only for its module side effects`,
    });
  }
}

function addTestLeakageFindings(
  graph: ProjectGraph,
  tests: string[],
  findings: Violation[]
): void {
  for (const edge of graph.edges) {
    if (!matchesAny(edge.to, tests) || matchesAny(edge.from, tests)) continue;
    findings.push({
      file: edge.from,
      line: edge.line,
      rule: "test-file-leakage",
      identity: `test-file-leakage:${edge.from}:${edge.line}:${edge.to}`,
      message: `${edge.from} imports test-only file ${edge.to}`,
    });
  }
}

function addTeamBoundaryFindings(
  graph: ProjectGraph,
  config: ResolvedConfig,
  findings: Violation[]
): void {
  const ownerByLayer = new Map<string, string>();
  for (const [team, layers] of Object.entries(config.teams))
    for (const layer of layers) ownerByLayer.set(layer, team);
  if (ownerByLayer.size === 0) return;
  const seenEdges = new Set<string>();
  const ownedEdges: Array<{
    edge: ImportEdge;
    fromTeam: string;
    toTeam: string;
  }> = [];
  for (const edge of graph.edges) {
    const key = `${edge.from}\0${edge.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    const fromLayer = layerFor(edge.from, config);
    const toLayer = layerFor(edge.to, config);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;
    const fromTeam = ownerByLayer.get(fromLayer);
    const toTeam = ownerByLayer.get(toLayer);
    if (fromTeam !== undefined && toTeam !== undefined)
      ownedEdges.push({ edge, fromTeam, toTeam });
  }
  const crossTeamEdges = ownedEdges.filter(
    ({ fromTeam, toTeam }) => fromTeam !== toTeam
  );
  const mismatch = `${crossTeamEdges.length}/${ownedEdges.length} (${ownedEdges.length ? Math.round((crossTeamEdges.length / ownedEdges.length) * 100) : 0}%)`;
  for (const { edge, fromTeam, toTeam } of crossTeamEdges)
    findings.push({
      file: edge.from,
      line: edge.line,
      rule: "team-boundary",
      identity: `${edge.from}:${edge.to}`,
      message: `${fromTeam} -> ${toTeam} dependency crosses team ownership; Conway mismatch index ${mismatch}`,
    });
}

function addCohesionFindings(
  ctx: ProjectContext,
  graph: ProjectGraph,
  findings: Violation[]
): void {
  const classFiles = graph.files.filter((file) =>
    /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(file)
  );
  for (const file of classFiles) {
    const text = ctx.read(file);
    if (text === null) continue;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      sourceKind(file)
    );
    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
        const methods = node.members.filter(
          (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) &&
            Boolean(member.body) &&
            member.name.getText(source) !== "constructor"
        );
        const methodNames = new Set(
          methods.map((method) => method.name.getText(source))
        );
        const fields = new Set(
          node.members
            .filter((member): member is ts.PropertyDeclaration =>
              ts.isPropertyDeclaration(member)
            )
            .map((member) => member.name.getText(source))
        );
        const usedFields = methods.map((method) => {
          const used = new Set<string>();
          const scan = (part: ts.Node) => {
            if (
              ts.isPropertyAccessExpression(part) &&
              part.expression.kind === ts.SyntaxKind.ThisKeyword &&
              fields.has(part.name.text)
            )
              used.add(part.name.text);
            ts.forEachChild(part, scan);
          };
          if (method.body) scan(method.body);
          return used;
        });
        const parent = methods.map((_, index) => index);
        const find = (index: number): number =>
          parent[index] === index
            ? index
            : (parent[index] = find(parent[index]!));
        const join = (a: number, b: number) => {
          parent[find(a)] = find(b);
        };
        for (let i = 0; i < methods.length; i++)
          for (let j = i + 1; j < methods.length; j++) {
            const sharesField = [...usedFields[i]!].some((field) =>
              usedFields[j]!.has(field)
            );
            const calls = (
              method: ts.MethodDeclaration,
              target: ts.MethodDeclaration
            ) => {
              let result = false;
              const scan = (part: ts.Node) => {
                if (
                  ts.isCallExpression(part) &&
                  ts.isPropertyAccessExpression(part.expression) &&
                  part.expression.expression.kind ===
                    ts.SyntaxKind.ThisKeyword &&
                  methodNames.has(part.expression.name.text) &&
                  part.expression.name.text === target.name.getText(source)
                )
                  result = true;
                ts.forEachChild(part, scan);
              };
              if (method.body) scan(method.body);
              return result;
            };
            const callsMethod =
              calls(methods[i]!, methods[j]!) ||
              calls(methods[j]!, methods[i]!);
            if (sharesField || callsMethod) join(i, j);
          }
        const components = new Set(methods.map((_, index) => find(index))).size;
        if (methods.length > 1 && components > 1) {
          const line =
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1;
          const name = node.name?.getText(source) ?? "anonymous class";
          findings.push({
            file,
            line,
            rule: "lcom4",
            identity: `${file}:class:${name}`,
            metrics: { components: { value: components, worsening: "higher" } },
            message: `${name} has ${components} disconnected method groups (LCOM4)`,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

export function coChangeFindingsFromLog(
  log: string,
  graph: ProjectGraph,
  threshold: number
): Violation[] {
  const counts = new Map<string, number>();
  const knownFiles = new Set(graph.files);
  let changed = new Set<string>();
  const flush = () => {
    const files = [...changed].sort();
    if (files.length <= 80)
      for (let i = 0; i < files.length; i++)
        for (let j = i + 1; j < files.length; j++) {
          const key = `${files[i]}\0${files[j]}`;
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    changed = new Set();
  };
  for (const line of log.split("\n")) {
    if (line.startsWith("\x01")) {
      flush();
      continue;
    }
    if (knownFiles.has(line)) changed.add(line);
  }
  flush();
  const findings: Violation[] = [];
  for (const [key, count] of counts)
    if (count >= threshold) {
      const [from, to] = key.split("\0") as [string, string];
      findings.push({
        file: from,
        line: 0,
        rule: "shotgun-surgery",
        identity: `${from}<->${to}`,
        metrics: { coChanges: { value: count, worsening: "higher" } },
        message: `${from} and ${to} changed together in ${count} recent commits; review for scattered responsibilities`,
      });
    }
  return findings;
}

function addCoChangeFindings(
  root: string,
  graph: ProjectGraph,
  threshold: number,
  findings: Violation[]
): void {
  try {
    const log = execFileSync(
      "git",
      ["-C", root, "log", "-n", "150", "--format=%x01", "--name-only"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    findings.push(...coChangeFindingsFromLog(log, graph, threshold));
  } catch {
    return;
  }
}

export function coChangeRevision(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export const architectureGraphRuleIds = [
  "circular-dependency",
  "type-circular-dependency",
  "layer-boundary",
  "context-boundary",
  "stable-dependencies",
  "stability-distance",
  "lcom4",
  "shotgun-surgery",
  "team-boundary",
  "team-mismatch",
  "package-circular-dependency",
  "hub-module",
  "high-coupling",
  "hub-dependency",
  "vendor-coupling",
  "max-instability",
  "side-effect-import",
  "test-file-leakage",
] as const;

function graphRuleEnabled(config: ResolvedConfig, id: string): boolean {
  return (config.rules[id]?.level ?? config.defaultLevel ?? "off") !== "off";
}

function graphSignature(
  ctx: ProjectContext,
  settings: CompilerSettings,
  includeTests: boolean
): string {
  const hash = createHash("sha256");
  const adrDirectory = normalizeProjectDirectory(ctx.config.adrDir);
  const testFiles = includeTests
    ? (ctx.listFilesOutsideScan?.(".") ?? []).filter(
        (file) =>
          extensions.some((extension) => file.endsWith(extension)) &&
          matchesAny(file, ctx.config.tests)
      )
    : [];
  const packageManifests = new Set(
    packageManifestPaths([...ctx.listFiles(extensions), ...testFiles])
  );
  hash.update(
    enclosingPackageSignature(
      ctx.root,
      [...ctx.listFiles(extensions), ...testFiles],
      ctx.read
    )
  );
  const adrPrefix =
    adrDirectory && adrDirectory !== "." ? `${adrDirectory}/` : "";
  const files = new Set([
    ...ctx.listFiles(),
    ...packageManifests,
    ...(ctx.config.adrDir
      ? (ctx.listFilesOutsideScan?.(adrDirectory || ".") ?? [])
      : []),
    ...testFiles,
    ...settings.files,
  ]);
  for (const file of [...files].sort()) {
    const relevant =
      settings.files.includes(file) ||
      extensions.some((extension) => file.endsWith(extension)) ||
      (ctx.config.adrDir !== "" &&
        (!adrPrefix || file.startsWith(adrPrefix)) &&
        file.endsWith(".md")) ||
      packageManifests.has(file);
    if (relevant) hash.update(file).update(ctx.read(file) ?? "");
  }
  hash.update(JSON.stringify(ctx.config));
  if (ctx.config.graph.coChange) hash.update(coChangeRevision(ctx.root));
  return hash.digest("hex");
}

export const architectureGraphRule: ProjectRule = {
  kind: "project",
  id: "architecture-graph",
  description:
    "AST import graph: cycles, declared layer boundaries, context ports and structural metrics",
  defaultLevel: "off",
  check(ctx) {
    const settings = compilerSettings(ctx);
    const testLeakageEnabled = graphRuleEnabled(
      ctx.config,
      "test-file-leakage"
    );
    const signature = graphSignature(ctx, settings, testLeakageEnabled);
    const cached = findingCache.get(ctx.root);
    if (cached?.signature === signature) return cached.findings;
    const graph = buildProjectGraphWithSettings(ctx, settings);
    const levelForGraphRule = (id: string) =>
      graphRuleEnabled(ctx.config, id) ? "error" : "off";
    const adr = parseAdrRules(ctx);
    const config = mergeAdrLayers(ctx.config, adr);
    const layers = config.layers;
    validateGraphConfig(config);
    for (const [key, source] of [...adr.allows, ...adr.denies]) {
      const [from, to] = key.split("->") as [string, string];
      if (!layers[from])
        throw new Error(
          `${source.file}:${source.line} references unknown layer "${from}"`
        );
      if (!layers[to])
        throw new Error(
          `${source.file}:${source.line} references unknown layer "${to}"`
        );
    }
    const allowed = new Map<string, Set<string>>();
    for (const [from, targets] of Object.entries(
      ctx.config.allowedDependencies
    ))
      allowed.set(from, new Set(targets));
    for (const [key, source] of adr.denies) {
      const [from, to] = key.split("->") as [string, string];
      if (allowed.get(from)?.has(to))
        throw new Error(
          `${source.file}:${source.line} denies ${from} -> ${to}, but arch-lint.config.json allows it`
        );
    }
    for (const [key, source] of adr.allows) {
      const [from, to] = key.split("->") as [string, string];
      if (adr.denies.has(key))
        throw new Error(
          `${adr.denies.get(key)!.file}:${adr.denies.get(key)!.line} denies ${from} -> ${to}, but ${source.file}:${source.line} allows it`
        );
      (
        allowed.get(from) ?? (allowed.set(from, new Set()), allowed.get(from)!)
      ).add(to);
    }
    for (const name of Object.keys(layers))
      if (allowed.has(name))
        for (const target of allowed.get(name)!)
          if (!layers[target])
            throw new Error(
              `allowedDependencies.${name} references unknown layer "${target}"`
            );
    const findings: Violation[] = [];
    for (const group of graph.cycles) {
      const members = new Set(group);
      const edge = graph.edges.find(
        (candidate) => members.has(candidate.from) && members.has(candidate.to)
      );
      findings.push({
        file: edge?.from ?? group[0]!,
        line: edge?.line ?? 1,
        rule: "circular-dependency",
        identity: `cycle:${group.join("|")}`,
        message: `Circular dependency cluster across ${group.length} files: ${group.join(", ")}`,
      });
    }
    for (const group of stronglyConnected(
      graph.files,
      graph.edges.filter((edge) => edge.typeOnly)
    )) {
      const members = new Set(group);
      const edge = graph.edges.find(
        (candidate) =>
          candidate.typeOnly &&
          members.has(candidate.from) &&
          members.has(candidate.to)
      );
      findings.push({
        file: edge?.from ?? group[0]!,
        line: edge?.line ?? 1,
        rule: "type-circular-dependency",
        identity: `type-cycle:${group.join("|")}`,
        message: `Type-only circular dependency across ${group.length} files: ${group.join(", ")}`,
      });
    }
    addPackageCycleFindings(ctx, graph, findings);
    for (const edge of graph.edges) {
      const from = layerFor(edge.from, config);
      const to = layerFor(edge.to, config);
      if (!from || !to || from === to) continue;
      const key = `${from}->${to}`;
      const denial = adr.denies.get(key);
      if (denial || (allowed.has(from) && !allowed.get(from)!.has(to))) {
        const source = denial
          ? ` (denied by ${denial.file}:${denial.line})`
          : "";
        findings.push({
          file: edge.from,
          line: edge.line,
          rule: "layer-boundary",
          identity: `${edge.from}:${edge.line}:${edge.to}`,
          message: `${from} may not import ${to}${source}`,
        });
      }
      const fromContext = contextFor(from, ctx.config.contexts);
      const toContext = contextFor(to, ctx.config.contexts);
      if (
        fromContext &&
        toContext &&
        fromContext.name !== toContext.name &&
        !toContext.public.includes(to)
      ) {
        findings.push({
          file: edge.from,
          line: edge.line,
          rule: "context-boundary",
          identity: `${fromContext.name}:${edge.from}:${edge.line}:${edge.to}`,
          message: `${fromContext.name} imports internal layer ${toContext.name}/${to}; expose it as a public port or move the dependency`,
        });
      }
    }
    addLayerMetrics(graph, config, findings);
    addTeamBoundaryFindings(graph, config, findings);
    if (levelForGraphRule("team-mismatch") !== "off")
      addTeamMismatchFindings(graph, config, findings);
    if (levelForGraphRule("max-instability") !== "off")
      addMaxInstabilityFindings(graph, config, findings);
    if (levelForGraphRule("hub-module") !== "off")
      addHubModuleFindings(graph, config, findings);
    if (levelForGraphRule("high-coupling") !== "off")
      addHighCouplingFindings(graph, config, findings);
    if (levelForGraphRule("hub-dependency") !== "off")
      addHubDependencyFindings(graph, config, findings);
    if (levelForGraphRule("vendor-coupling") !== "off")
      addVendorCouplingFindings(graph, config, findings);
    if (levelForGraphRule("side-effect-import") !== "off")
      addSideEffectImportFindings(graph, findings);
    if (levelForGraphRule("test-file-leakage") !== "off") {
      const graphWithTests = buildProjectGraphWithSettings(ctx, settings, true);
      addTestLeakageFindings(graphWithTests, ctx.config.tests, findings);
    }
    addCohesionFindings(ctx, graph, findings);
    if (ctx.config.graph.coChange)
      addCoChangeFindings(
        ctx.root,
        graph,
        ctx.config.graph.coChangeThreshold,
        findings
      );
    findingCache.set(ctx.root, { signature, findings });
    return findings;
  },
};

export const architectureGraphRules: ProjectRule[] =
  architectureGraphRuleIds.map((id) => ({
    kind: "project",
    id,
    description: `AST dependency graph check: ${id}`,
    defaultLevel: "off",
    check: async (ctx) =>
      (await architectureGraphRule.check(ctx)).filter(
        (finding) => finding.rule === id
      ),
  }));
