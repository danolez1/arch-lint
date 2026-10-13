import assert from "node:assert/strict";
import test from "node:test";
import { checkProject } from "./helpers";

const first = `export function normalizeInvoice(value: number) {
  const first = value + 1;
  const second = first * 2;
  if (second > 0) {
    const third = second - 3;
    const fourth = third / 4;
    const fifth = fourth + 5;
    return fifth;
  }
  return second;
}`;

const formattedClone = `export function normalizeReceipt(value:number){
// Retain this path while historical receipts remain in circulation.
const first=value+1; const second=first*2;
if(second>0){const third=second-3;
const fourth=third/4;const fifth=fourth+5;
return fifth;}
return second;
}`;

test("code-clone finds identical AST blocks despite comments and formatting", async () => {
  const findings = await checkProject("code-clone", {
    "src/invoice.ts": first,
    "src/receipt.ts": formattedClone,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/receipt.ts");
  assert.match(findings[0]?.message ?? "", /src\/invoice\.ts:1/);
});

test("code-clone scans JavaScript modules as well as TypeScript", async () => {
  const findings = await checkProject("code-clone", {
    "src/invoice.js": first,
    "src/receipt.mjs": formattedClone,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/receipt.mjs");
});

test("code-clone ignores blocks below configured thresholds", async () => {
  const findings = await checkProject(
    "code-clone",
    { "src/a.ts": first, "src/b.ts": formattedClone },
    { options: { minTokens: 1000 } }
  );
  assert.deepEqual(findings, []);
});

test("code-clone honors its minimum code-line threshold", async () => {
  const findings = await checkProject(
    "code-clone",
    { "src/a.ts": first, "src/b.ts": formattedClone },
    { options: { minLines: 100 } }
  );
  assert.deepEqual(findings, []);
});

test("code-clone finds shared statement runs inside different blocks", async () => {
  const findings = await checkProject(
    "code-clone",
    {
      "src/a.ts": [
        "export function first(value: number) {",
        "  const first = value + 1;",
        "  const second = first * 2;",
        "  if (second > 0) { return second + 1; }",
        "  return second;",
        "}",
      ].join("\n"),
      "src/b.ts": [
        "export function second(value: number) {",
        "  const first = value + 1;",
        "  const second = first * 2;",
        "  if (second > 0) { return second - 1; }",
        "  return -second;",
        "}",
      ].join("\n"),
    },
    { options: { minTokens: 10, minLines: 2 } }
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/b.ts");
  assert.equal(findings[0]?.line, 2);
  assert.match(findings[0]?.message ?? "", /14 tokens across 2 lines/);
});

test("code-clone reports partial copies beside a larger clone", async () => {
  const prefix = [
    "  const first = value + 1;",
    "  const second = first * 2;",
    "  const third = second + 3;",
    "  const fourth = third * 4;",
    "  const fifth = fourth + 5;",
    "  const sixth = fifth * 6;",
  ];
  const file = (tail: string) =>
    ["function copy(value: number) {", ...prefix, `  ${tail}`, "}"].join("\n");
  const findings = await checkProject(
    "code-clone",
    {
      "src/a.ts": file("return finishA(sixth);"),
      "src/b.ts": file("return finishA(sixth);"),
      "src/c.ts": file("return finishC(sixth);"),
    },
    { options: { minTokens: 10, minLines: 3 } }
  );
  assert.deepEqual(
    findings.map(({ file, line }) => [file, line]),
    [
      ["src/b.ts", 1],
      ["src/c.ts", 2],
    ]
  );
});

test("code-clone extends overlapping matches to their maximal shared run", async () => {
  const file = (tail: string) =>
    [
      "function copy(x: number) {",
      "  const first = x + x + x;",
      "  const second = x + x + x;",
      "  a;",
      "  b;",
      "  c;",
      `  ${tail}`,
      "}",
    ].join("\n");
  const findings = await checkProject(
    "code-clone",
    {
      "src/a.ts": file("finishA();"),
      "src/b.ts": file("finishB();"),
    },
    { options: { minTokens: 15, minLines: 2 } }
  );
  assert.deepEqual(
    findings.map(({ file, line }) => [file, line]),
    [["src/b.ts", 2]]
  );
  assert.match(findings[0]?.message ?? "", /24 tokens across 5 lines/);
});

test("code-clone expands long runs without emitting a finding per chunk", async () => {
  const statements = Array.from({ length: 120 }, () => "    consume(value);");
  const source = (tag: string, result: string) =>
    [
      `function ${tag}(value: number) {`,
      `  const tag = "${tag}";`,
      ...statements,
      `  return ${result};`,
      "}",
    ].join("\n");
  const findings = await checkProject(
    "code-clone",
    {
      "src/copies.ts": [
        source("first", "tag + 1"),
        source("second", "tag + 2"),
      ].join("\n"),
    },
    { options: { minTokens: 15, minLines: 2 } }
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/copies.ts");
  assert.match(findings[0]?.message ?? "", /600 tokens across 120 lines/);
});

test("code-clone reports a long repeated run within one block once", async () => {
  const statements = Array.from({ length: 100 }, () => "  touch();");
  const findings = await checkProject("code-clone", {
    "src/repeated.ts": ["function work() {", ...statements, "}"].join("\n"),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/repeated.ts");
  assert.equal(findings[0]?.line, 3);
  assert.match(findings[0]?.message ?? "", /occurs 100 times in a row/);
  assert.match(findings[0]?.message ?? "", /396 tokens across 99 lines/);
});

test("code-clone gives separate same-line repeated runs distinct identities", async () => {
  const findings = await checkProject(
    "code-clone",
    {
      "src/repeated.ts":
        "function work() { foo(); foo(); bar(); foo(); foo(); }",
    },
    { options: { minTokens: 4, minLines: 1 } }
  );
  assert.equal(findings.length, 2);
  assert.notEqual(findings[0]?.identity, findings[1]?.identity);
});

test("code-clone counts lexical tokens in partial statement runs", async () => {
  const findings = await checkProject(
    "code-clone",
    {
      "src/a.ts": "function a() { foo(); left(); }",
      "src/b.ts": "function b() { foo(); right(); }",
    },
    { options: { minTokens: 5, minLines: 1 } }
  );
  assert.deepEqual(findings, []);
});

test("code-clone ignores test files and different AST tokens", async () => {
  const changed = formattedClone.replace("second-3", "second-4");
  const findings = await checkProject("code-clone", {
    "src/a.ts": first,
    "src/b.ts": changed,
    "src/c.test.ts": formattedClone,
  });
  assert.deepEqual(findings, []);
});

test("code-clone rejects nonpositive thresholds", async () => {
  await assert.rejects(
    checkProject(
      "code-clone",
      { "src/a.ts": first, "src/b.ts": formattedClone },
      { options: { minTokens: 0 } }
    ),
    /minTokens must be a positive integer/
  );
});
