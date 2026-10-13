import { createHash } from "node:crypto";
import type { ArchitectureMetrics, ProjectGraph } from "./graph";
import type { Comparison, Violation } from "./types";

export type ReportFormat =
  "text" | "json" | "sarif" | "github" | "gitlab" | "metrics" | "mermaid";

const location = (v: Violation) =>
  v.line > 0 ? `${v.file}:${v.line}` : v.file;

function withoutBaselineIdentity(finding: Violation): Violation {
  const result = { ...finding };
  delete result.baselineIdentity;
  return result;
}

export function report(
  result: Comparison,
  total: number,
  showAll: Violation[] | null,
  scanned: number,
  format: ReportFormat = "text",
  graph?: ProjectGraph,
  metrics?: ArchitectureMetrics
): number {
  if (format === "metrics") {
    if (!metrics)
      throw new Error("Metrics output requires architecture metrics");
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
    return result.fresh.length > 0 ? 1 : 0;
  }

  if (format === "mermaid") {
    if (!graph) throw new Error("Mermaid output requires a dependency graph");
    process.stdout.write(`${toMermaid(graph)}\n`);
    return result.fresh.length > 0 ? 1 : 0;
  }

  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          tool: "arch-lint",
          passed: result.fresh.length === 0,
          scanned,
          total,
          new: result.fresh.length,
          debt: result.debt,
          fixed: result.fixed,
          findings: result.fresh.map(withoutBaselineIdentity),
          ...(showAll
            ? { allFindings: showAll.map(withoutBaselineIdentity) }
            : {}),
        },
        null,
        2
      )}\n`
    );
    return result.fresh.length > 0 ? 1 : 0;
  }

  if (format === "sarif") {
    const rules = [...new Set(result.fresh.map((finding) => finding.rule))].map(
      (id) => ({
        id,
        shortDescription: { text: id },
      })
    );
    const results = result.fresh.map((finding) => ({
      ruleId: finding.rule,
      level: "error",
      message: { text: finding.message },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: sarifUri(finding.file) },
            ...(finding.line > 0
              ? { region: { startLine: finding.line } }
              : {}),
          },
        },
      ],
      ...(finding.identity
        ? {
            partialFingerprints: {
              identity: finding.identity,
            },
          }
        : {}),
    }));
    process.stdout.write(
      `${JSON.stringify(
        {
          $schema: "https://json.schemastore.org/sarif-2.1.0.json",
          version: "2.1.0",
          runs: [
            {
              tool: { driver: { name: "arch-lint", rules } },
              results,
              invocations: [{ executionSuccessful: true }],
              properties: {
                scanned,
                total,
                new: result.fresh.length,
                debt: result.debt,
                fixed: result.fixed,
              },
            },
          ],
        },
        null,
        2
      )}\n`
    );
    return result.fresh.length > 0 ? 1 : 0;
  }

  if (format === "github") {
    for (const finding of result.fresh) {
      const properties = [
        `file=${escapeAnnotationProperty(finding.file)}`,
        ...(finding.line > 0 ? [`line=${finding.line}`] : []),
        `title=${escapeAnnotationProperty(finding.rule)}`,
      ];
      process.stdout.write(
        `::error ${properties.join(",")}::${escapeAnnotationMessage(finding.message)}\n`
      );
    }
    return result.fresh.length > 0 ? 1 : 0;
  }

  if (format === "gitlab") {
    const findings = result.fresh.map((finding) => ({
      description: finding.message,
      check_name: finding.rule,
      fingerprint: createHash("sha256")
        .update(
          `${finding.rule}\0${finding.identity ?? `${finding.file}\0${finding.line}\0${finding.message}`}`
        )
        .digest("hex"),
      severity: "major",
      location: {
        path: finding.file.replace(/^\.\//, ""),
        lines: { begin: Math.max(1, finding.line) },
      },
    }));
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    return result.fresh.length > 0 ? 1 : 0;
  }

  const lines: string[] = [
    `Architecture lint: scanned ${scanned} source files`,
  ];
  const byRule = new Map<string, Violation[]>();
  for (const v of result.fresh)
    byRule.set(v.rule, [...(byRule.get(v.rule) ?? []), v]);

  for (const [rule, items] of byRule) {
    lines.push(`\n${rule} (${items.length})`);
    for (const v of items) lines.push(`  ${location(v)}  ${v.message}`);
  }

  if (showAll) {
    const counts = new Map<string, number>();
    for (const v of showAll) counts.set(v.rule, (counts.get(v.rule) ?? 0) + 1);
    lines.push("\nAll current violations by rule (baselined debt included):");
    for (const [rule, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(count).padStart(5)}  ${rule}`);
    }
  }

  lines.push(
    `\n${total} violation(s) found: ${result.fresh.length} new, ${result.debt} baselined debt.`
  );
  if (result.fixed > 0) {
    lines.push(
      `${result.fixed} baselined violation(s) no longer occur; run "arch-lint arch --update-baseline" to lock the gain in.`
    );
  }
  lines.push(
    result.fresh.length > 0
      ? "Architecture lint failed."
      : "Architecture lint passed."
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.fresh.length > 0 ? 1 : 0;
}

function toMermaid(graph: ProjectGraph): string {
  const ids = new Map(graph.files.map((file, index) => [file, `f${index}`]));
  const cycleFiles = new Set(graph.cycles.flat());
  const lines = ["graph LR"];
  for (const file of graph.files)
    lines.push(
      `  ${ids.get(file)}["${file.replace(/"/g, "#quot;").replace(/[\r\n]+/g, "\\n")}"]`
    );
  for (const edge of graph.edges) {
    const arrow = edge.typeOnly ? "-. type .->" : "-->";
    lines.push(`  ${ids.get(edge.from)} ${arrow} ${ids.get(edge.to)}`);
  }
  const members = [...cycleFiles].map((file) => ids.get(file)).filter(Boolean);
  if (members.length > 0) {
    lines.push(
      "  classDef cycleNode fill:#ffe4e6,stroke:#be123c,color:#881337"
    );
    lines.push(`  class ${members.join(",")} cycleNode`);
  }
  return lines.join("\n");
}

function sarifUri(file: string): string {
  return file
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function escapeAnnotationProperty(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

function escapeAnnotationMessage(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
