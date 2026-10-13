import { statSync } from "node:fs";
import path from "node:path";
import {
  assertBaselineMode,
  canonicalizeBaseline,
  compareToBaseline,
  readBaseline,
  writeBaseline,
} from "./baseline";
import { loadConfigSources, resolveConfig } from "./config";
import { diskFileSystem } from "./files";
import {
  architectureConfigWithAdrLayers,
  architectureGraphRuleIds,
  architectureMetrics,
  buildProjectGraph,
  coChangeRevision,
  graphConfigFiles,
  graphEnclosingPackageManifestFiles,
  graphPackageManifestFiles,
} from "./graph";
import { matchesAny } from "./paths";
import { REGISTRY, canonicalId } from "./registry";
import type { ReportFormat } from "./report";
import { report } from "./report";
import { runJournalCheck } from "./rules/migrations";
import { runRules } from "./run";

interface Args {
  all: boolean;
  updateBaseline: boolean;
  journal: boolean;
  baseAbsent: boolean;
  list: boolean;
  help: boolean;
  graph: boolean;
  watch: boolean;
  format: ReportFormat;
  config?: string;
  only: string[];
  root: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    updateBaseline: false,
    journal: false,
    baseAbsent: false,
    list: false,
    help: false,
    graph: false,
    watch: false,
    format: "text",
    only: [],
    root: process.cwd(),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] = arg.split("=", 2);
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`${flag} requires a value`);
      return v;
    };
    if (flag === "--all") args.all = true;
    else if (flag === "--update-baseline") args.updateBaseline = true;
    else if (flag === "--journal") args.journal = true;
    else if (flag === "--base-absent") args.baseAbsent = true;
    else if (flag === "--list") args.list = true;
    else if (flag === "--help") args.help = true;
    else if (flag === "--graph") args.graph = true;
    else if (flag === "--watch") {
      args.watch = true;
      args.graph = true;
    } else if (flag === "--format") {
      const format = value();
      if (
        ![
          "text",
          "json",
          "sarif",
          "github",
          "gitlab",
          "metrics",
          "mermaid",
        ].includes(format)
      )
        throw new Error(`Unknown report format "${format}"`);
      args.format = format as ReportFormat;
    } else if (flag === "--config") args.config = value();
    else if (flag === "--rule")
      args.only.push(...value().split(",").filter(Boolean));
    else if (flag === "--root") args.root = path.resolve(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      [
        "Usage: arch-lint arch [options]",
        "",
        "Options:",
        "  --all                     Include baselined findings",
        "  --base-absent             Treat a missing baseline as empty",
        "  --config <path>           Read a config file",
        "  --format <format>         text, json, sarif, github, gitlab, metrics, mermaid",
        "  --graph                   Run architecture graph checks",
        "  --journal                 Check architecture decision records",
        "  --list                    List registered rules",
        "  --root <path>             Analyze a project directory",
        "  --rule <id,...>           Run selected rules",
        "  --update-baseline         Save current findings as tolerated debt",
        "  --watch                   Re-run when architecture inputs change",
      ].join("\n") + "\n"
    );
    return 0;
  }
  if (args.list) {
    for (const rule of REGISTRY)
      process.stdout.write(
        `${rule.id.padEnd(44)} ${rule.kind.padEnd(8)} ${rule.description}\n`
      );
    return 0;
  }
  if (args.format === "mermaid" || args.format === "metrics") args.graph = true;
  const loadRunConfig = () => {
    const loaded = loadConfigSources(args.root, args.config);
    const config = resolveConfig(loaded.config);
    if (args.graph && args.format !== "metrics") {
      if (args.only.includes("architecture-graph")) {
        config.rules["architecture-graph"] = {
          ...config.rules["architecture-graph"],
          level: "error",
        };
      } else {
        config.rules["architecture-graph"] = { level: "off" };
        for (const id of architectureGraphRuleIds)
          config.rules[id] = { ...config.rules[id], level: "error" };
      }
    } else if (args.format === "metrics") {
      config.rules["architecture-graph"] = {
        ...config.rules["architecture-graph"],
        level: args.only.includes("architecture-graph") ? "error" : "off",
      };
      for (const id of architectureGraphRuleIds)
        config.rules[id] = {
          ...config.rules[id],
          level: args.only.includes(id) ? "error" : "off",
        };
    } else {
      if (args.only.includes("architecture-graph"))
        config.rules["architecture-graph"] = {
          ...config.rules["architecture-graph"],
          level: "error",
        };
      if (!config.rules["architecture-graph"])
        config.rules["architecture-graph"] = { level: "off" };
      for (const id of architectureGraphRuleIds)
        if (!config.rules[id]) config.rules[id] = { level: "off" };
    }
    return { config, configFiles: loaded.files };
  };
  let { config, configFiles } = loadRunConfig();
  if (args.journal) return runJournalCheck(args.root, config, args.baseAbsent);
  if (args.watch && args.updateBaseline)
    throw new Error("--watch cannot be combined with --update-baseline");

  const run = async () => {
    const baseline = args.updateBaseline
      ? undefined
      : canonicalizeBaseline(
          readBaseline(args.root, config.baseline),
          canonicalId
        );
    if (baseline) assertBaselineMode(baseline, config.baselineMode);
    const fs = diskFileSystem(args.root, config);
    const { violations, scanned } = await runRules({
      root: args.root,
      config,
      fs,
      only: args.only,
    });
    if (args.updateBaseline) {
      const entries = writeBaseline(
        args.root,
        config.baseline,
        violations,
        canonicalId,
        config.baselineMode
      );
      process.stdout.write(
        `Baseline written: ${violations.length} violation(s) across ${entries} file/rule pair(s).\n`
      );
      return 0;
    }
    const graphContext = {
      root: args.root,
      config,
      options: {},
      inLayer: () => true,
      hasLayer: (layer: string) => config.layers[layer] !== undefined,
      files: [],
      listFiles: (extensions?: string[]) =>
        fs
          .list()
          .filter(
            (file) =>
              !extensions ||
              extensions.some((extension) => file.endsWith(extension))
          ),
      listFilesOutsideScan: (directory: string) =>
        fs.listDirectory?.(directory) ?? fs.list(),
      read: fs.read,
    };
    const graph =
      args.format === "mermaid" || args.format === "metrics"
        ? buildProjectGraph(graphContext)
        : undefined;
    const metricsConfig = graph
      ? architectureConfigWithAdrLayers(graphContext)
      : undefined;
    return report(
      compareToBaseline(violations, baseline!, canonicalId),
      violations.length,
      args.all ? violations : null,
      scanned,
      args.format,
      graph,
      graph && metricsConfig
        ? architectureMetrics(graph, metricsConfig)
        : undefined
    );
  };

  const graphInputs = () => {
    const fs = diskFileSystem(args.root, config);
    const sourcePattern = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
    const sourceFiles = fs.list().filter((file) => sourcePattern.test(file));
    const testLeakageEnabled =
      (config.rules["test-file-leakage"]?.level ??
        config.defaultLevel ??
        "off") !== "off";
    const testFiles = testLeakageEnabled
      ? (fs.listDirectory?.(".") ?? []).filter(
          (file) => sourcePattern.test(file) && matchesAny(file, config.tests)
        )
      : [];
    return [
      ...graphConfigFiles(
        args.root,
        fs.read,
        fs.listDirectory?.(".") ?? fs.list()
      ),
      ...graphPackageManifestFiles([...sourceFiles, ...testFiles]),
      ...graphEnclosingPackageManifestFiles(args.root, [
        ...sourceFiles,
        ...testFiles,
      ]),
      ...testFiles,
      ...(testLeakageEnabled
        ? [".", ...(fs.listDirectories?.(".") ?? [])]
        : []),
    ];
  };
  const loadWatchSnapshot = () => {
    let loaded = loadRunConfig();
    for (;;) {
      config = loaded.config;
      configFiles = loaded.configFiles;
      const graphFiles = graphInputs();
      const signature = watchSignature(
        args.root,
        config,
        args.config,
        configFiles,
        graphFiles
      );
      const confirmed = loadRunConfig();
      if (
        JSON.stringify([loaded.config, loaded.configFiles]) ===
        JSON.stringify([confirmed.config, confirmed.configFiles])
      ) {
        config = confirmed.config;
        configFiles = confirmed.configFiles;
        return { graphFiles, signature };
      }
      loaded = confirmed;
    }
  };
  let graphFiles: string[] = [];
  let previous = "";
  if (args.watch) ({ graphFiles, signature: previous } = loadWatchSnapshot());
  const firstResult = await run();
  if (!args.watch) return firstResult;
  process.stdout.write("Watching architecture inputs. Press Ctrl-C to stop.\n");
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const current = watchSignature(
      args.root,
      config,
      args.config,
      configFiles,
      graphFiles
    );
    if (current === previous) continue;
    ({ graphFiles, signature: previous } = loadWatchSnapshot());
    process.stdout.write("\nArchitecture inputs changed.\n");
    await run();
  }
}

function watchSignature(
  root: string,
  config: ReturnType<typeof resolveConfig>,
  configPath?: string,
  configFiles: string[] = [],
  graphFiles: string[] = []
): string {
  const fs = diskFileSystem(root, config);
  const inputs = new Set([
    ...fs.list(),
    ...(config.adrDir ? (fs.listDirectory?.(config.adrDir) ?? []) : []),
    config.baseline,
    "arch-lint.config.json",
    "tsconfig.json",
    "jsconfig.json",
    ...configFiles,
    ...graphFiles,
    ...(configPath ? [configPath] : []),
  ]);
  return (
    [...inputs]
      .sort()
      .map((file) => {
        try {
          const stat = statSync(
            path.isAbsolute(file) ? file : path.join(root, file),
            { bigint: true }
          );
          return `${file}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch {
          return `${file}:missing`;
        }
      })
      .join("\n") +
    (config.graph.coChange ? `\ngit:${coChangeRevision(root)}` : "")
  );
}

process.exitCode = await main();
