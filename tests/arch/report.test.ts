import assert from "node:assert/strict";
import test from "node:test";
import { report } from "../../src/arch/report";

const finding = {
  file: "src/a,b.ts",
  line: 7,
  rule: "circular-dependency",
  message: "cycle % detected\nnext line",
};

function capture(run: () => number): { code: number; output: string } {
  let output = "";
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    return { code: run(), output };
  } finally {
    process.stdout.write = write;
  }
}

test("SARIF marks a completed scan successful even when it finds violations", () => {
  const output = capture(() =>
    report({ fresh: [finding], debt: 0, fixed: 0 }, 1, null, 2, "sarif")
  );
  const result = JSON.parse(output.output);
  assert.equal(output.code, 1);
  assert.equal(result.runs[0].invocations[0].executionSuccessful, true);
  assert.equal(result.runs[0].results[0].ruleId, "circular-dependency");
});

test("GitHub annotations escape property delimiters and message line breaks", () => {
  const output = capture(() =>
    report({ fresh: [finding], debt: 0, fixed: 0 }, 1, null, 2, "github")
  );
  assert.equal(output.code, 1);
  assert.equal(
    output.output,
    "::error file=src/a%2Cb.ts,line=7,title=circular-dependency::cycle %25 detected%0Anext line\n"
  );
});

test("GitLab code quality output has stable fingerprints and valid locations", () => {
  const sharedIdentity = { ...finding, identity: "src/a.ts->src/b.ts" };
  const sameEdgeOtherRule = {
    ...sharedIdentity,
    rule: "team-boundary",
  };
  const output = capture(() =>
    report(
      {
        fresh: [
          sharedIdentity,
          sameEdgeOtherRule,
          { ...finding, file: "./src/b.ts", line: 0 },
        ],
        debt: 0,
        fixed: 0,
      },
      3,
      null,
      2,
      "gitlab"
    )
  );
  const result = JSON.parse(output.output);
  assert.equal(output.code, 1);
  assert.equal(result.length, 3);
  assert.equal(result[0].check_name, "circular-dependency");
  assert.equal(result[0].location.path, "src/a,b.ts");
  assert.equal(result[0].location.lines.begin, 7);
  assert.equal(result[1].check_name, "team-boundary");
  assert.notEqual(result[0].fingerprint, result[1].fingerprint);
  assert.equal(result[2].location.path, "src/b.ts");
  assert.equal(result[2].location.lines.begin, 1);
  assert.match(result[0].fingerprint, /^[a-f0-9]{64}$/);
});

test("GitLab fingerprints keep distinct same-rule dependency findings separate", () => {
  const findings = ["src/domain/model.ts", "src/domain/service.ts"].map(
    (target, index) => ({
      ...finding,
      file: "src/app/page.ts",
      line: index + 1,
      rule: "stable-dependencies",
      identity: `src/app/page.ts:${index + 1}:${target}:app->domain`,
    })
  );
  const output = capture(() =>
    report({ fresh: findings, debt: 0, fixed: 0 }, 2, null, 3, "gitlab")
  );
  const result = JSON.parse(output.output);
  assert.equal(result.length, 2);
  assert.notEqual(result[0].fingerprint, result[1].fingerprint);
});

test("reports preserve unique source identities while baseline identity is shared", () => {
  const findings = [0, 1].map((occurrence) => ({
    ...finding,
    rule: "dead-symbols",
    identity: `src/a.ts:function:api/block:target:${occurrence}`,
    baselineIdentity: "src/a.ts:function:api/block:target",
  }));
  const gitlabOutput = capture(() =>
    report({ fresh: findings, debt: 0, fixed: 0 }, 2, null, 2, "gitlab")
  );
  const sarifOutput = capture(() =>
    report({ fresh: findings, debt: 0, fixed: 0 }, 2, null, 2, "sarif")
  );
  const gitlabResults = JSON.parse(gitlabOutput.output);
  const sarifResults = JSON.parse(sarifOutput.output).runs[0].results;

  assert.notEqual(gitlabResults[0].fingerprint, gitlabResults[1].fingerprint);
  assert.notEqual(
    sarifResults[0].partialFingerprints.identity,
    sarifResults[1].partialFingerprints.identity
  );
  assert.equal(
    sarifResults[0].partialFingerprints.identity,
    findings[0].identity
  );
  assert.equal("baselineIdentity" in sarifResults[0], false);
});

test("GitLab fingerprint follows the source identity when a live duplicate precedes a finding", () => {
  const baselineIdentity = "src/a.ts:function:api/block:target";
  const previous = {
    ...finding,
    rule: "dead-symbols",
    identity: `${baselineIdentity}:0`,
    baselineIdentity,
  };
  const current = {
    ...previous,
    line: finding.line + 4,
    identity: `${baselineIdentity}:1`,
  };
  const fingerprint = (currentFinding: typeof previous) => {
    const output = capture(() =>
      report(
        { fresh: [currentFinding], debt: 0, fixed: 0 },
        1,
        null,
        2,
        "gitlab"
      )
    );
    return JSON.parse(output.output)[0].fingerprint as string;
  };

  assert.notEqual(fingerprint(current), fingerprint(previous));
});

test("reports keep a surviving duplicate identity after its sibling is fixed", () => {
  const baselineIdentity = "src/a.ts:function:api/block:target";
  const findings = [0, 1].map((occurrence) => ({
    ...finding,
    rule: "dead-symbols",
    identity: `${baselineIdentity}:${occurrence}`,
    baselineIdentity,
  }));
  const second = findings[1]!;
  const gitlab = (fresh: typeof findings) => {
    const output = capture(() =>
      report({ fresh, debt: 0, fixed: 0 }, fresh.length, null, 2, "gitlab")
    );
    return JSON.parse(output.output) as Array<{ fingerprint: string }>;
  };
  const sarif = (fresh: typeof findings) => {
    const output = capture(() =>
      report({ fresh, debt: 0, fixed: 0 }, fresh.length, null, 2, "sarif")
    );
    return JSON.parse(output.output).runs[0].results as Array<{
      partialFingerprints: { identity: string };
    }>;
  };

  assert.equal(
    gitlab([second])[0]?.fingerprint,
    gitlab(findings)[1]?.fingerprint
  );
  assert.equal(
    sarif([second])[0]?.partialFingerprints.identity,
    sarif(findings)[1]?.partialFingerprints.identity
  );
});

test("JSON output includes fresh findings and legacy counters", () => {
  const output = capture(() =>
    report({ fresh: [finding], debt: 3, fixed: 2 }, 4, null, 5, "json")
  );
  const result = JSON.parse(output.output);
  assert.equal(output.code, 1);
  assert.equal(result.scanned, 5);
  assert.equal(result.total, 4);
  assert.equal(result.debt, 3);
  assert.equal(result.fixed, 2);
  assert.deepEqual(result.findings, [finding]);
});

test("JSON report omits internal baseline identities", () => {
  const output = capture(() =>
    report(
      {
        fresh: [{ ...finding, baselineIdentity: "internal-key" }],
        debt: 0,
        fixed: 0,
      },
      1,
      null,
      2,
      "json"
    )
  );
  const result = JSON.parse(output.output);

  assert.equal("baselineIdentity" in result.findings[0], false);
});

test("Mermaid output labels file edges and marks cycle participants", () => {
  const output = capture(() =>
    report({ fresh: [], debt: 0, fixed: 0 }, 0, null, 2, "mermaid", {
      files: ["src/a.ts", "src/b.ts"],
      edges: [
        { from: "src/a.ts", to: "src/b.ts", line: 1, typeOnly: true },
        { from: "src/b.ts", to: "src/a.ts", line: 2, typeOnly: false },
      ],
      cycles: [["src/a.ts", "src/b.ts"]],
    })
  );
  assert.equal(output.code, 0);
  assert.match(output.output, /f0\["src\/a\.ts"\]/);
  assert.match(output.output, /f0 -\. type \.-> f1/);
  assert.match(output.output, /class f0,f1 cycleNode/);
});

test("Mermaid labels keep quotes and newlines inside the node label", () => {
  const output = capture(() =>
    report({ fresh: [], debt: 0, fixed: 0 }, 0, null, 1, "mermaid", {
      files: ['src/a"\n b.ts'],
      edges: [],
      cycles: [],
    })
  );
  assert.equal(output.code, 0);
  assert.match(output.output, /src\/a#quot;\\n b\.ts/);
  assert.equal(output.output.split("\n").length, 3);
});
