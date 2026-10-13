import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertBaselineMode,
  canonicalizeBaseline,
  compareToBaseline,
  readBaseline,
  writeBaseline,
} from "../../src/arch/baseline";
import type { Violation } from "../../src/arch/types";

const finding = (line: number): Violation => ({
  file: "src/service.ts",
  line,
  rule: "no-raw-throw",
  message: "Use the service error helper",
});

test("finding baselines survive line movement and identify new duplicate findings", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  try {
    writeBaseline(root, "baseline.json", [finding(4)]);
    const baseline = readBaseline(root, "baseline.json");
    const comparison = compareToBaseline([finding(24), finding(37)], baseline);
    assert.equal(comparison.debt, 1);
    assert.equal(comparison.fresh.length, 1);
    assert.equal(comparison.fresh[0]?.line, 37);
    assert.equal(compareToBaseline([], baseline).fixed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("legacy rule aliases remain canonical after migration to version 2", () => {
  const baseline = canonicalizeBaseline(
    { version: 2, findings: [], legacy: { "old-rule::src/service.ts": 1 } },
    (id) => (id === "old-rule" ? "new-rule" : id)
  );
  const comparison = compareToBaseline(
    [{ ...finding(4), rule: "new-rule" }],
    baseline
  );
  assert.equal(comparison.fresh.length, 0);
  assert.equal(comparison.debt, 1);
});

test("worsening baselines compare metric direction and tolerate line movement", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  const coupled = (line: number, fanIn: number): Violation => ({
    file: "src/hub.ts",
    line,
    rule: "high-coupling",
    identity: "coupling:src/hub.ts",
    metrics: { fanIn: { value: fanIn, worsening: "higher" } },
    message: `src/hub.ts exceeds coupling limits with fan-in ${fanIn}`,
  });
  try {
    writeBaseline(
      root,
      "baseline.json",
      [coupled(1, 21)],
      (id) => id,
      "worsening"
    );
    const baseline = readBaseline(root, "baseline.json");
    assert.equal(baseline.version, 5);
    assert.equal(baseline.mode, "worsening");
    assertBaselineMode(baseline, "worsening");
    assert.equal(compareToBaseline([coupled(20, 21)], baseline).debt, 1);
    assert.equal(compareToBaseline([coupled(20, 20)], baseline).debt, 1);
    const worsened = compareToBaseline([coupled(20, 22)], baseline);
    assert.equal(worsened.fresh.length, 1);
    assert.equal(worsened.debt, 0);
    assert.equal(worsened.fixed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worsening baselines detect raw metric changes hidden by rounded messages", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  const instability = (value: number): Violation => ({
    file: "src/layers/service.ts",
    line: 1,
    rule: "max-instability",
    identity: "max-instability:service",
    metrics: { instability: { value, worsening: "higher" } },
    message: `service has instability ${value.toFixed(2)}, above the maximum 0.8`,
  });
  try {
    const before = 25 / (25 + 6);
    const after = 26 / (26 + 6);
    assert.equal(instability(before).message, instability(after).message);
    writeBaseline(
      root,
      "baseline.json",
      [instability(before)],
      (id) => id,
      "worsening"
    );
    const comparison = compareToBaseline(
      [instability(after)],
      readBaseline(root, "baseline.json")
    );
    assert.equal(comparison.fresh.length, 1);
    assert.equal(comparison.debt, 0);
    assert.equal(comparison.fixed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worsening baselines honor metrics that worsen when their values fall", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  const cohesion = (score: number): Violation => ({
    file: "src/module.ts",
    line: 1,
    rule: "custom-lower-metric",
    identity: "custom-lower-metric:src/module.ts",
    metrics: { score: { value: score, worsening: "lower" } },
    message: `src/module.ts cohesion is ${score}`,
  });
  try {
    writeBaseline(
      root,
      "baseline.json",
      [cohesion(0.6)],
      (id) => id,
      "worsening"
    );
    const baseline = readBaseline(root, "baseline.json");
    assert.equal(compareToBaseline([cohesion(0.65)], baseline).debt, 1);
    assert.equal(compareToBaseline([cohesion(0.55)], baseline).fresh.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("duplicate worsening findings match non-worsening metric combinations", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  const finding = (x: number, y: number): Violation => ({
    file: "src/service.ts",
    line: 1,
    rule: "complexity",
    identity: "service:helper",
    metrics: {
      x: { value: x, worsening: "higher" },
      y: { value: y, worsening: "higher" },
    },
    message: "helper exceeds complexity limits",
  });
  try {
    writeBaseline(
      root,
      "baseline.json",
      [finding(5, 5), finding(10, 0)],
      (id) => id,
      "worsening"
    );
    const comparison = compareToBaseline(
      [finding(5, 0), finding(5, 5)],
      readBaseline(root, "baseline.json")
    );
    assert.equal(comparison.fresh.length, 0);
    assert.equal(comparison.debt, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worsening baselines do not treat message edits as regressions", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  const item = (message: string): Violation => ({
    file: "src/service.ts",
    line: 1,
    rule: "no-raw-throw",
    identity: "no-raw-throw:src/service.ts:1",
    message,
  });
  try {
    writeBaseline(
      root,
      "baseline.json",
      [item("Use helper A")],
      (id) => id,
      "worsening"
    );
    const comparison = compareToBaseline(
      [item("Use helper B")],
      readBaseline(root, "baseline.json")
    );
    assert.equal(comparison.fresh.length, 0);
    assert.equal(comparison.debt, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identity baselines keep message changes tolerated by default", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  const coupled = (fanIn: number): Violation => ({
    file: "src/hub.ts",
    line: 1,
    rule: "high-coupling",
    identity: "coupling:src/hub.ts",
    message: `src/hub.ts exceeds coupling limits with fan-in ${fanIn}`,
  });
  try {
    writeBaseline(root, "baseline.json", [coupled(21)]);
    const comparison = compareToBaseline(
      [coupled(22)],
      readBaseline(root, "baseline.json")
    );
    assert.equal(comparison.fresh.length, 0);
    assert.equal(comparison.debt, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worsening mode requires refreshing populated identity baselines", () => {
  const legacy = { version: 2 as const, findings: ["old"], legacy: {} };
  assert.throws(
    () => assertBaselineMode(legacy, "worsening"),
    /refreshed baseline/
  );
  assert.doesNotThrow(() =>
    assertBaselineMode(
      { version: 3, findings: ["legacy identity"], legacy: {} },
      "identity"
    )
  );
  assert.throws(
    () =>
      assertBaselineMode(
        { version: 4, findings: ["old"], legacy: {} },
        "worsening"
      ),
    /refreshed baseline/
  );
  assert.doesNotThrow(() =>
    assertBaselineMode(
      { version: 5, mode: "worsening", findings: ["new"], legacy: {} },
      "worsening"
    )
  );
  assert.doesNotThrow(() =>
    assertBaselineMode(
      { version: 5, mode: "identity", findings: ["new"], legacy: {} },
      "identity"
    )
  );
  assert.throws(
    () =>
      assertBaselineMode(
        { version: 5, mode: "identity", findings: ["new"], legacy: {} },
        "worsening"
      ),
    /refreshed baseline/
  );
  assert.throws(
    () =>
      assertBaselineMode(
        { version: 5, mode: "worsening", findings: ["new"], legacy: {} },
        "identity"
      ),
    /refreshed baseline/
  );
  assert.doesNotThrow(() =>
    assertBaselineMode({ version: 2, findings: [], legacy: {} }, "worsening")
  );
  assert.throws(
    () => assertBaselineMode({ "high-coupling::src/hub.ts": 1 }, "worsening"),
    /refreshed baseline/
  );
  assert.throws(
    () =>
      assertBaselineMode(
        { version: 4, findings: ["new"], legacy: {} },
        "identity"
      ),
    /refreshed baseline/
  );
});

test("finding fingerprints stay scoped to their rule", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "arch-lint-baseline-"));
  const finding = (rule: string, value: number): Violation => ({
    file: "src/service.ts",
    line: 1,
    rule,
    identity: "src/service.ts:function:service/FunctionDeclaration:handle",
    metrics: { complexity: { value, worsening: "higher" } },
    message: `${rule} complexity is ${value}`,
  });
  try {
    writeBaseline(
      root,
      "baseline.json",
      [finding("cyclomatic-complexity", 2), finding("cognitive-complexity", 3)],
      undefined,
      "worsening"
    );
    const baseline = readBaseline(root, "baseline.json");
    const comparison = compareToBaseline(
      [finding("cognitive-complexity", 3)],
      baseline
    );
    assert.equal(comparison.fresh.length, 0);
    assert.equal(comparison.debt, 1);
    assert.equal(comparison.fixed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
