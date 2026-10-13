import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import ts from "typescript";
import {
  assertBaselineMode,
  canonicalizeBaseline,
  compareToBaseline,
  readBaseline,
} from "./baseline";
import { buildCallGraph } from "./callgraph";
import { levelFor, loadConfig, resolveConfig } from "./config";
import { collectArchitectureSourcePaths, diskFileSystem } from "./files";
import {
  architectureConfigWithAdrLayers,
  architectureGraphRuleIds,
  architectureMetrics,
  buildProjectGraph,
} from "./graph";
import { matchesAny, matchesPattern } from "./paths";
import { canonicalId, findRule } from "./registry";
import { runRules } from "./run";
import type { ProjectContext, ResolvedConfig, Violation } from "./types";

const rootArg = process.argv.indexOf("--root");
const root = path.resolve(
  rootArg >= 0 ? (process.argv[rootArg + 1] ?? process.cwd()) : process.cwd()
);
const protocolVersion = "2025-06-18";
const serverInfo = { name: "arch-lint", version: "0.1.0" };
function scannedSourceCount(config: ResolvedConfig): number {
  return collectArchitectureSourcePaths(diskFileSystem(root, config), config)
    .length;
}

function configWithGraph(
  config: ResolvedConfig,
  graph: boolean,
  only: string[]
): ResolvedConfig {
  if (graph && !only.includes("architecture-graph")) {
    config.rules["architecture-graph"] = { level: "off" };
    for (const id of architectureGraphRuleIds)
      config.rules[id] = { ...config.rules[id], level: "error" };
  } else {
    if (only.includes("architecture-graph"))
      config.rules["architecture-graph"] = {
        ...config.rules["architecture-graph"],
        level: "error",
      };
    if (!config.rules["architecture-graph"])
      config.rules["architecture-graph"] = { level: "off" };
    for (const id of architectureGraphRuleIds)
      if (!config.rules[id]) config.rules[id] = { level: "off" };
  }
  return config;
}

async function scan(args: Record<string, unknown>) {
  const only = Array.isArray(args.rules)
    ? args.rules.filter((entry): entry is string => typeof entry === "string")
    : [];
  const config = configWithGraph(
    resolveConfig(loadConfig(root)),
    args.graph === true,
    only
  );
  const baseline = canonicalizeBaseline(
    readBaseline(root, config.baseline),
    canonicalId
  );
  assertBaselineMode(baseline, config.baselineMode);
  const { violations } = await runRules({
    root,
    config,
    fs: diskFileSystem(root, config),
    only,
  });
  const comparison = compareToBaseline(violations, baseline, canonicalId);
  const file = typeof args.file === "string" ? projectFile(args.file) : null;
  const findings = comparison.fresh.filter(
    (finding) => file === null || finding.file === file
  );
  return {
    root,
    scanned: scannedSourceCount(config),
    total: violations.length,
    new: comparison.fresh.length,
    debt: comparison.debt,
    fixed: comparison.fixed,
    count_scope: "project",
    findings: findings.map(decisionEnvelope),
  };
}

function graphContext(
  config: ResolvedConfig,
  virtualFiles: Map<string, string> = new Map()
): ProjectContext {
  const fs = diskFileSystem(root, config);
  const currentFiles = new Set(fs.list());
  const inScan = (file: string) =>
    config.scan.some((pattern) => {
      const normalized = pattern.replace(/\\/g, "/");
      if (normalized === "." || normalized === "./") return true;
      if (/[*?{]/.test(normalized)) return matchesPattern(file, normalized);
      const directory = normalized.replace(/\/$/, "");
      return file === directory || file.startsWith(`${directory}/`);
    });
  return {
    root,
    config,
    options: {},
    inLayer: () => true,
    hasLayer: (layer) => config.layers[layer] !== undefined,
    files: [],
    listFiles: (extensions) =>
      [...new Set([...currentFiles, ...virtualFiles.keys()])].filter(
        (file) =>
          (inScan(file) || currentFiles.has(file)) &&
          !matchesAny(file, config.ignore) &&
          !matchesAny(file, config.tests) &&
          (!extensions ||
            extensions.some((extension) => file.endsWith(extension)))
      ),
    listFilesOutsideScan: (directory) =>
      fs.listDirectory?.(directory) ?? fs.list(),
    read: (file) => virtualFiles.get(file) ?? fs.read(file),
  };
}

function graphStats(
  config: ResolvedConfig,
  virtualFiles: Map<string, string> = new Map()
) {
  const graph = buildProjectGraph(graphContext(config, virtualFiles));
  return { files: graph.files, edges: graph.edges, cycles: graph.cycles };
}

function graphReport(config: ResolvedConfig) {
  const context = graphContext(config);
  const graph = buildProjectGraph(context);
  return {
    files: graph.files,
    edges: graph.edges,
    cycles: graph.cycles,
    metrics: architectureMetrics(
      graph,
      architectureConfigWithAdrLayers(context)
    ),
  };
}

function deletedSources(files: string[]): Map<string, string> {
  const deleted = new Map<string, string>();
  for (const file of files) {
    if (!/\.(?:[cm]?[jt]sx?)$/i.test(file) || existsSync(path.join(root, file)))
      continue;
    try {
      const contents = execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
      deleted.set(file, contents);
    } catch {
      // Files without a committed version are not deletions from the project graph.
    }
  }
  return deleted;
}

function dependencies(
  config: ResolvedConfig,
  rawFile: string,
  direction: string
) {
  const file = projectFile(rawFile);
  const graph = graphStats(config);
  if (!graph.files.includes(file))
    throw new Error(`Unknown source file "${file}"`);
  return {
    file,
    incoming:
      direction === "outgoing"
        ? []
        : graph.edges
            .filter((edge) => edge.to === file)
            .map((edge) => edge.from),
    outgoing:
      direction === "incoming"
        ? []
        : graph.edges
            .filter((edge) => edge.from === file)
            .map((edge) => edge.to),
  };
}

function projectFile(rawFile: string): string {
  if (path.isAbsolute(rawFile))
    throw new Error("file must be relative to the project root");
  const file = path.posix.normalize(rawFile.replace(/\\/g, "/"));
  if (file === ".." || file.startsWith("../"))
    throw new Error("file must stay inside the project root");
  return file;
}

function decisionEnvelope(finding: Violation) {
  const principle: Record<string, string> = {
    "circular-dependency": "Acyclic Dependencies Principle",
    "layer-boundary": "Layered Architecture",
    "context-boundary": "Bounded Contexts",
    "stable-dependencies": "Stable Dependencies Principle",
    "stability-distance": "Balanced Abstractions Principle",
    lcom4: "Cohesion",
    "shotgun-surgery": "Change locality",
    "team-boundary": "Team ownership boundaries",
    "team-mismatch": "Team ownership boundaries",
    "unstable-interface": "Stable Dependencies Principle",
    "package-circular-dependency": "Acyclic Dependencies Principle",
    "hub-module": "Single Responsibility Principle",
    "high-coupling": "Loose coupling",
    "hub-dependency": "Dependency concentration",
    "vendor-coupling": "External dependency isolation",
    "max-instability": "Stable Dependencies Principle",
    "side-effect-import": "Explicit side effects",
    "test-file-leakage": "Test isolation",
    "interface-segregation": "Interface Segregation Principle",
    "dependency-inversion": "Dependency Inversion Principle",
    "unused-export": "Keep public surface intentional",
    "orphan-type": "Keep types close to their consumers",
  };
  const remediation: Record<string, string> = {
    "circular-dependency":
      "Break the import cycle by extracting a lower-level module or reversing the dependency through an interface.",
    "layer-boundary":
      "Move the dependency behind an allowed layer boundary or update the architecture policy if this direction is intentional.",
    "context-boundary":
      "Depend on the configured public entry point of the target context, or revise that boundary if the dependency is intentional.",
    "unused-export":
      "Check runtime entry points and package consumers before removing the export; add legitimate entry points to the preset configuration.",
    "orphan-type":
      "Confirm generated and public API use before removing the type, then colocate it with its consumers if appropriate.",
    "interface-segregation":
      "Split the broad interface into focused contracts and depend on only the members each consumer needs.",
    "dependency-inversion":
      "Move the abstraction toward the policy-owning layer and inject the implementation at the composition boundary.",
  };
  const publicFinding = { ...finding };
  delete publicFinding.baselineIdentity;
  return {
    ...publicFinding,
    severity: "ERROR" as const,
    principle: principle[finding.rule] ?? finding.rule,
    remediation:
      remediation[finding.rule] ??
      `Review this ${finding.rule} finding and adjust the dependency or the configured architecture policy.`,
    human_in_loop: ["unused-export", "orphan-type"].includes(finding.rule),
    requires_delta: true,
    location: { file: finding.file, line: finding.line },
  };
}

function currentChanges(): string[] {
  const tracked = execFileSync(
    "git",
    ["diff", "--no-renames", "--name-only", "HEAD", "--", "."],
    {
      cwd: root,
      encoding: "utf8",
    }
  );
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" }
  );
  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean))]
    .map(projectFile)
    .sort();
}

async function analyzeChange(args: Record<string, unknown>) {
  const changed = Array.isArray(args.files)
    ? args.files.map((file) => {
        if (typeof file !== "string")
          throw new Error("files must contain only strings");
        return projectFile(file);
      })
    : currentChanges();
  const config = resolveConfig(loadConfig(root));
  const deleted = deletedSources(changed);
  const graph = graphStats(config, deleted);
  const affected = new Set(
    changed.filter((file) => graph.files.includes(file))
  );
  const incoming = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const sources = incoming.get(edge.to) ?? [];
    sources.push(edge.from);
    incoming.set(edge.to, sources);
  }
  const queue = [...affected];
  while (queue.length) {
    const file = queue.shift() as string;
    for (const importer of incoming.get(file) ?? []) {
      if (!affected.has(importer)) {
        affected.add(importer);
        queue.push(importer);
      }
    }
  }
  const result = await scan({});
  return {
    changedFiles: changed,
    affectedFiles: [...affected].sort(),
    findings: result.findings.filter((finding) => affected.has(finding.file)),
  };
}

function analyzeFile(rawFile: string) {
  const file = projectFile(rawFile);
  const config = resolveConfig(loadConfig(root));
  const graph = graphStats(config);
  if (!graph.files.includes(file))
    throw new Error(`Unknown source file "${file}"`);
  const text = diskFileSystem(root, config).read(file);
  if (text === null) throw new Error(`Unable to read source file "${file}"`);
  const kind = /\.tsx$/i.test(file)
    ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(file)
      ? ts.ScriptKind.JSX
      : /\.(?:[cm]?js)$/i.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    kind
  );
  const declarations: Array<{ name: string; kind: string; line: number }> = [];
  const functions = buildCallGraph({ root, entryFile: file }).functions.map(
    ({ name, line }) => ({ name, line })
  );
  const visit = (node: ts.Node) => {
    const declaration =
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node);
    if (declaration && node.name) {
      declarations.push({
        name: node.name.text,
        kind: ts.SyntaxKind[node.kind],
        line:
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const imports = graph.edges
    .filter((edge) => edge.from === file)
    .map((edge) => ({
      file: edge.to,
      line: edge.line,
      typeOnly: edge.typeOnly,
    }));
  const exports = source.statements.flatMap((statement) => {
    const hasExportModifier =
      ts.canHaveModifiers(statement) &&
      (ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false);
    const line =
      source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1;
    if (ts.isExportAssignment(statement))
      return [{ name: "default", kind: "ExportAssignment", line }];
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        return statement.exportClause.elements.map((element) => ({
          name: element.name.text,
          kind: "ExportDeclaration",
          line,
        }));
      return [{ name: "<re-export>", kind: "ExportDeclaration", line }];
    }
    if (!hasExportModifier) return [];
    if (ts.isVariableStatement(statement))
      return statement.declarationList.declarations.flatMap((declaration) => {
        const names: string[] = [];
        const collect = (name: ts.BindingName) => {
          if (ts.isIdentifier(name)) names.push(name.text);
          else
            for (const element of name.elements)
              if (ts.isBindingElement(element)) collect(element.name);
        };
        collect(declaration.name);
        return names.map((name) => ({
          name,
          kind: "VariableStatement",
          line,
        }));
      });
    const name = (statement as ts.NamedDeclaration).name;
    return [
      {
        name: name && ts.isIdentifier(name) ? name.text : "default",
        kind: ts.SyntaxKind[statement.kind],
        line,
      },
    ];
  });
  return { file, functions, declarations, imports, exports };
}

const emptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const scanInputSchema = {
  type: "object",
  properties: {
    graph: { type: "boolean" },
    file: { type: "string" },
    rules: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};
const dependencyInputSchema = {
  type: "object",
  properties: {
    file: { type: "string" },
    direction: { type: "string", enum: ["incoming", "outgoing", "both"] },
  },
  required: ["file"],
  additionalProperties: false,
};
const ruleInputSchema = {
  type: "object",
  properties: { rule: { type: "string" } },
  required: ["rule"],
  additionalProperties: false,
};
const fileInputSchema = {
  type: "object",
  properties: { file: { type: "string" } },
  required: ["file"],
  additionalProperties: false,
};
const changeInputSchema = {
  type: "object",
  properties: { files: { type: "array", items: { type: "string" } } },
  additionalProperties: false,
};
const callgraphInputSchema = {
  type: "object",
  properties: {
    file: { type: "string" },
    function: { type: "string" },
  },
  additionalProperties: false,
};
const tools = [
  {
    name: "archlint_scan",
    description:
      "Run configured architecture rules. Set graph true to include AST dependency analysis.",
    inputSchema: scanInputSchema,
  },
  {
    name: "archlint_graph",
    description:
      "Return resolved local imports and multi-file dependency cycles.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "archlint_stats",
    description: "Return dependency graph file, import-edge, and cycle counts.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "archlint_metrics",
    description:
      "Return file fan-in and fan-out, layer coupling metrics, and team mismatch ratio.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "archlint_dependencies",
    description: "Return resolved importers and imports for one source file.",
    inputSchema: dependencyInputSchema,
  },
  {
    name: "archlint_explain",
    description:
      "Return the description and configured level for one architecture rule.",
    inputSchema: ruleInputSchema,
  },
  {
    name: "check_violations",
    description:
      "Run configured rules and return new findings with severity, principle, remediation, baseline status, and location.",
    inputSchema: scanInputSchema,
  },
  {
    name: "get_architecture",
    description:
      "Return the local import graph, cycles, and architecture metrics.",
    inputSchema: emptyInputSchema,
  },
  {
    name: "get_dependencies",
    description: "Return resolved importers and imports for one source file.",
    inputSchema: dependencyInputSchema,
  },
  {
    name: "analyze_file",
    description:
      "Summarize functions, declarations, exports, and local imports in one TypeScript or JavaScript file.",
    inputSchema: fileInputSchema,
  },
  {
    name: "analyze_change",
    description:
      "Find changed source files, their transitive importers, and new findings. If files is omitted, inspect the current git worktree.",
    inputSchema: changeInputSchema,
  },
  {
    name: "get_callgraph",
    description:
      "Return resolved local function-call and constructor edges, optionally filtered by file or function name.",
    inputSchema: callgraphInputSchema,
  },
];

async function callTool(name: string, rawArgs: unknown) {
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  if (name === "archlint_scan" || name === "check_violations")
    return scan(args);
  if (name === "archlint_graph") {
    const config = resolveConfig(loadConfig(root));
    return graphStats(config);
  }
  if (name === "get_architecture") {
    const config = resolveConfig(loadConfig(root));
    return graphReport(config);
  }
  if (name === "archlint_stats") {
    const graph = graphStats(resolveConfig(loadConfig(root)));
    return {
      files: graph.files.length,
      imports: graph.edges.length,
      cycles: graph.cycles.length,
      cycleFiles: graph.cycles.reduce((sum, group) => sum + group.length, 0),
    };
  }
  if (name === "archlint_metrics") {
    const config = resolveConfig(loadConfig(root));
    return graphReport(config).metrics;
  }
  if (name === "archlint_dependencies" || name === "get_dependencies") {
    if (typeof args.file !== "string") throw new Error("file must be a string");
    const direction = args.direction ?? "both";
    if (
      direction !== "incoming" &&
      direction !== "outgoing" &&
      direction !== "both"
    )
      throw new Error('direction must be "incoming", "outgoing", or "both"');
    return dependencies(resolveConfig(loadConfig(root)), args.file, direction);
  }
  if (name === "analyze_file") {
    if (typeof args.file !== "string") throw new Error("file must be a string");
    return analyzeFile(args.file);
  }
  if (name === "analyze_change") return analyzeChange(args);
  if (name === "get_callgraph") {
    const file =
      typeof args.file === "string" ? projectFile(args.file) : undefined;
    const functionName =
      typeof args.function === "string" ? args.function : undefined;
    const graph = buildCallGraph({ root, entryFile: file, functionName });
    return graph;
  }
  if (name === "archlint_explain") {
    if (typeof args.rule !== "string") throw new Error("rule must be a string");
    const rule = findRule(args.rule);
    if (!rule) throw new Error(`Unknown rule "${args.rule}"`);
    const config = resolveConfig(loadConfig(root));
    return {
      id: rule.id,
      description: rule.description,
      level: levelFor(config, rule),
    };
  }
  throw new Error(`Unknown tool "${name}"`);
}

function respond(id: unknown, result: unknown) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function rpcError(id: unknown, code: number, message: string) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`
  );
}

async function handle(message: unknown) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const request = message as Record<string, unknown>;
  const id = request.id;
  if (request.jsonrpc !== "2.0") {
    if (id !== undefined) rpcError(id, -32600, "Invalid request");
    return;
  }
  const method = request.method;
  if (typeof method !== "string") {
    if (id !== undefined) rpcError(id, -32600, "Invalid request");
    return;
  }
  const params =
    request.params && typeof request.params === "object"
      ? (request.params as Record<string, unknown>)
      : {};
  try {
    if (method === "initialize") {
      respond(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo,
      });
    } else if (
      method === "notifications/initialized" ||
      method === "notifications/cancelled" ||
      method === "notifications/progress"
    ) {
      return;
    } else if (method === "ping") {
      respond(id, {});
    } else if (method === "tools/list") {
      respond(id, { tools });
    } else if (method === "tools/call") {
      if (typeof params.name !== "string")
        throw Object.assign(new Error("name is required"), { code: -32602 });
      try {
        const result = await callTool(params.name, params.arguments);
        respond(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (error) {
        respond(id, {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          isError: true,
        });
      }
    } else if (method === "shutdown") {
      respond(id, {});
    } else if (method === "exit") {
      process.exit(0);
    } else if (id !== undefined) {
      rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "number"
        ? error.code
        : -32603;
    if (id !== undefined)
      rpcError(
        id,
        code,
        error instanceof Error ? error.message : String(error)
      );
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  try {
    await handle(JSON.parse(line));
  } catch {
    rpcError(null, -32700, "Parse error");
  }
}
