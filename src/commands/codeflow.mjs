import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PKG_ROOT, UsageError, run } from "../util.mjs";

const CODEFLOW = path.join(PKG_ROOT, "src", "codeflow");

const VALUE = new Set([
  "path",
  "out",
  "label",
  "since",
  "alias",
  "exclude",
  "envelope",
  "verdicts",
  "options",
]);
const SWITCH = new Set(["stdout", "no-tracked"]);
const REPEATED = new Set(["exclude", "alias"]);

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (SWITCH.has(name)) {
      opts[name] = true;
    } else if (VALUE.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined)
        throw new UsageError(`--${name} requires a value`);
      if (REPEATED.has(name)) (opts[name] ??= []).push(value);
      else opts[name] = value;
    } else {
      throw new UsageError(`Unknown option --${name}`);
    }
  }
  if (opts._.length > 0)
    throw new UsageError(`Unexpected argument "${opts._[0]}"`);
  return opts;
}

async function headless() {
  return import(
    pathToFileURL(path.join(CODEFLOW, "headless", "index.mjs")).href
  );
}

function aliasMap(list) {
  if (!list) return undefined;
  return Object.fromEntries(
    list.map((entry) => {
      const [from, to] = entry.split("=");
      if (!from || to === undefined)
        throw new UsageError(`--alias expects prefix=target, got "${entry}"`);
      return [from, to];
    })
  );
}

function readEnvelope(file) {
  if (!file || !existsSync(file))
    throw new UsageError("--envelope <file> is required and must exist");
  return JSON.parse(readFileSync(file, "utf8"));
}

async function analyze(opts, { root }) {
  const { analyzeProject } = await headless();
  const result = await analyzeProject({
    root: path.resolve(root, opts.path ?? "."),
    outDir: opts.out ? path.resolve(root, opts.out) : undefined,
    label: opts.label,
    exclude: opts.exclude,
    aliases: aliasMap(opts.alias),
    trackedOnly: opts["no-tracked"] ? false : undefined,
    churnSince: opts.since,
  });
  const { envelope } = result;
  if (opts.stdout) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    const summary = { ...result };
    delete summary.envelope;
    delete summary.hotspots;
    delete summary.health;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }
  return 0;
}

async function verify(opts, { root }) {
  const { verifyFindings } = await headless();
  const envelope = readEnvelope(opts.envelope);
  const verdicts = verifyFindings({
    root: path.resolve(root, opts.path ?? "."),
    envelope,
  });
  const json = JSON.stringify(verdicts, null, 2);
  if (opts.out) writeFileSync(path.resolve(root, opts.out), `${json}\n`);
  else process.stdout.write(`${json}\n`);
  return 0;
}

async function audit(opts, { root }) {
  const { renderAudit } = await headless();
  const envelope = readEnvelope(opts.envelope);
  if (!opts.verdicts || !existsSync(opts.verdicts))
    throw new UsageError("--verdicts <file> is required and must exist");
  const extra = opts.options
    ? JSON.parse(readFileSync(opts.options, "utf8"))
    : {};
  const out = renderAudit({
    root: path.resolve(root, opts.path ?? "."),
    envelope,
    verdicts: JSON.parse(readFileSync(opts.verdicts, "utf8")),
    label: opts.label,
    outPath: opts.out ? path.resolve(root, opts.out) : undefined,
    ...extra,
  });
  if (!opts.out)
    process.stdout.write(
      typeof out === "string" ? out : `${JSON.stringify(out, null, 2)}\n`
    );
  return 0;
}

async function selfTest() {
  const tests = path.join(CODEFLOW, "tests");
  if (!existsSync(tests))
    throw new UsageError(
      "CodeFlow tests are not shipped in the published package."
    );
  return run(process.execPath, ["--test", "tests/*.test.mjs"], {
    cwd: CODEFLOW,
  });
}

const COMMANDS = { analyze, verify, audit };

export async function codeflow(argv, ctx) {
  const [sub = "analyze", ...rest] = argv;
  if (sub === "test") return selfTest();
  const command = COMMANDS[sub];
  if (!command)
    throw new UsageError(
      `Unknown codeflow subcommand "${sub}". Use analyze, verify, audit or test.`
    );
  return command(parse(rest), ctx);
}
