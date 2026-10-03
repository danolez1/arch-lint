import path from "node:path";
import {
  canonicalizeBaseline,
  compareToBaseline,
  readBaseline,
  writeBaseline,
} from "./baseline";
import { loadConfig, resolveConfig } from "./config";
import { diskFileSystem } from "./files";
import { REGISTRY, canonicalId } from "./registry";
import { report } from "./report";
import { runJournalCheck } from "./rules/migrations";
import { runRules } from "./run";

interface Args {
  all: boolean;
  updateBaseline: boolean;
  journal: boolean;
  list: boolean;
  config?: string;
  only: string[];
  root: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    all: false,
    updateBaseline: false,
    journal: false,
    list: false,
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
    else if (flag === "--list") args.list = true;
    else if (flag === "--config") args.config = value();
    else if (flag === "--rule")
      args.only.push(...value().split(",").filter(Boolean));
    else if (flag === "--root") args.root = path.resolve(value());
    else throw new Error(`Unknown option ${arg}`);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const rule of REGISTRY)
      process.stdout.write(
        `${rule.id.padEnd(44)} ${rule.kind.padEnd(8)} ${rule.description}\n`
      );
    return 0;
  }
  const config = resolveConfig(loadConfig(args.root, args.config));
  if (args.journal) return runJournalCheck(args.root, config);

  const { violations, scanned } = await runRules({
    root: args.root,
    config,
    fs: diskFileSystem(args.root, config),
    only: args.only,
  });

  if (args.updateBaseline) {
    const entries = writeBaseline(args.root, config.baseline, violations);
    process.stdout.write(
      `Baseline written: ${violations.length} violation(s) across ${entries} file/rule pair(s).\n`
    );
    return 0;
  }

  const baseline = canonicalizeBaseline(
    readBaseline(args.root, config.baseline),
    canonicalId
  );
  return report(
    compareToBaseline(violations, baseline),
    violations.length,
    args.all ? violations : null,
    scanned
  );
}

process.exitCode = await main();
