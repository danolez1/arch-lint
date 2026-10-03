import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { loadAnalyzer } = require(join(__dirname, '..', '..', 'src', 'codeflow', 'lib', 'analyzer.js'));

test('bounded duplicate similarity keeps near-copies distinct from unrelated code', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const first = 'function processAlpha(items) { const out = []; for (const item of items) { if (item.ok) out.push(item.id); } return out; }';
  const renamed = 'function processBeta(rows) { const result = []; for (const row of rows) { if (row.ok) result.push(row.id); } return result; }';
  const unrelated = 'async function fetchUser(id) { const response = await fetch(`/users/${id}`); return response.json(); }';

  assert.ok(Parser.codeSimilarity(first, renamed) > 0.7);
  assert.ok(Parser.codeSimilarity(first, unrelated) < 0.5);
});

test('duplicate groups do not pull unrelated functions from the same coarse bucket', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const functions = [
    {
      name: 'processAlpha',
      file: 'src/a.js',
      line: 1,
      code: 'function processAlpha(items) { const out = []; for (const item of items) { if (item.ok) out.push(item.id); } return out; }',
    },
    {
      name: 'processBeta',
      file: 'src/b.js',
      line: 1,
      code: 'function processBeta(rows) { const result = []; for (const row of rows) { if (row.ok) result.push(row.id); } return result; }',
    },
    {
      name: 'validateSession',
      file: 'src/c.js',
      line: 1,
      code: 'function validateSession(user) { const cache = []; for (const role of user.roles) { if (role.active) cache.push(role.name); } return cache; }',
    },
  ];

  const duplicates = Parser.detectDuplicates([], functions).filter((duplicate) => duplicate.type === 'code');

  assert.equal(duplicates.length, 1);
  assert.deepEqual(
    Array.from(duplicates[0].files, (file) => file.file),
    ['src/a.js', 'src/b.js']
  );
});

test('duplicate grouping finds exact normalized matches despite intervening same-length peers', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const functions = [
    {
      name: 'copyAlpha',
      file: 'src/a.js',
      line: 1,
      code: 'function copyAlpha(items) { const out = []; for (const item of items) { if (item.ok) out.push(item.id); } return out; }',
    },
    {
      name: 'firstPeer',
      file: 'src/b.js',
      line: 1,
      code: 'function firstPeer(items) { const out = []; for (const item of items) { if (item.no) out.push(item.id); } return out; }',
    },
    {
      name: 'secondPeer',
      file: 'src/c.js',
      line: 1,
      code: 'function secondPeer(items) { const out = []; for (const item of items) { if (item.up) out.push(item.id); } return out; }',
    },
    {
      name: 'copyOmega',
      file: 'src/d.js',
      line: 1,
      code: 'function copyOmega(items) { const out = []; for (const item of items) { if (item.ok) out.push(item.id); } return out; }',
    },
  ];

  const duplicates = Parser.detectDuplicates([], functions).filter((duplicate) => duplicate.type === 'code');
  const exact = duplicates.find((duplicate) => duplicate.files.some((file) => file.file === 'src/a.js'));

  assert.notEqual(exact, undefined);
  assert.deepEqual(Array.from(exact.files, (file) => file.file), ['src/a.js', 'src/d.js']);
});

test('duplicate grouping checks fuzzy matches beyond adjacent candidates', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const functions = [
    {
      name: 'copyAlpha',
      file: 'src/a.js',
      line: 1,
      code: 'function copyAlpha(items) { const output = []; for (const item of items) { if (item.ready) output.push(item.value); } return output; }',
    },
    {
      name: 'peerOne',
      file: 'src/b.js',
      line: 1,
      code: 'function peerOne(items) { const errors = []; for (const item of items) { if (item.failed) errors.push(item.code); } return errors.length; }',
    },
    {
      name: 'peerTwo',
      file: 'src/c.js',
      line: 1,
      code: 'function peerTwo(items) { let total = 0; for (const item of items) { if (item.ready) total += item.cost; } return total; }',
    },
    {
      name: 'copyOmega',
      file: 'src/d.js',
      line: 1,
      code: 'function copyOmega(rows) { const output = []; for (const row of rows) { if (row.ready) output.push(row.value); } return output; }',
    },
  ];

  const duplicates = Parser.detectDuplicates([], functions).filter((duplicate) => duplicate.type === 'code');

  assert.equal(
    duplicates.some((duplicate) => {
      const files = new Set(duplicate.files.map((file) => file.file));
      return files.has('src/a.js') && files.has('src/d.js');
    }),
    true
  );
});

test('exact duplicate grouping preserves behavior-changing literals', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const functions = [
    {
      name: 'allowAdmin',
      file: 'src/allow.js',
      line: 1,
      code: 'function allowAdmin(user) { if (!user) throw new Error("missing-user"); return user.role === "admin" && user.level >= 10; }',
    },
    {
      name: 'allowGuest',
      file: 'src/guest.js',
      line: 1,
      code: 'function allowGuest(user) { if (!user) throw new Error("missing-guest"); return user.role === "guest" && user.level >= 1; }',
    },
  ];

  const duplicates = Parser.detectDuplicates([], functions).filter((duplicate) => duplicate.type === 'code');

  assert.equal(duplicates.some((duplicate) => duplicate.similarity === 100), false);
});

test('duplicate clusters do not chain mutually dissimilar endpoints', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const functions = [
    {
      name: 'chainBridge',
      file: 'src/b.js',
      line: 1,
      code: 'function chainBridge(items) { const sharedMarker = "bridge"; for (const item of items) consume(sharedMarker, item); return sharedMarker; }',
    },
    {
      name: 'chainAlpha',
      file: 'src/a.js',
      line: 1,
      code: 'function chainAlpha(items) { const sharedMarker = "alpha"; for (const item of items) consume(sharedMarker, item); return sharedMarker; }',
    },
    {
      name: 'chainOmega',
      file: 'src/c.js',
      line: 1,
      code: 'function chainOmega(items) { const sharedMarker = "omega"; for (const item of items) consume(sharedMarker, item); return sharedMarker; }',
    },
  ];
  const originalSimilarity = Parser.codeSimilarity;
  Parser.codeSimilarity = (left, right) => {
    const pair = [left.match(/chain(Alpha|Bridge|Omega)/)?.[1], right.match(/chain(Alpha|Bridge|Omega)/)?.[1]].sort().join(':');
    if (pair === 'Alpha:Bridge' || pair === 'Bridge:Omega') return 0.8;
    if (pair === 'Alpha:Omega') return 0.5;
    return 0;
  };

  let duplicates;
  try {
    duplicates = Parser.detectDuplicates([], functions).filter((duplicate) => duplicate.type === 'code');
  } finally {
    Parser.codeSimilarity = originalSimilarity;
  }

  assert.equal(
    duplicates.some((duplicate) => {
      const files = new Set(duplicate.files.map((file) => file.file));
      return files.has('src/a.js') && files.has('src/c.js');
    }),
    false
  );
});

test('same-file fuzzy match does not hide a later cross-file match', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const functions = [
    ...Array.from({ length: 9 }, (_, index) => ({
      name: `leftLocal${index}`,
      file: 'src/shared.js',
      line: index + 1,
      code: `function leftLocal${index}(items) { const sharedMarker = "left-${index}"; for (const item of items) consume(sharedMarker, item); return sharedMarker; }`,
    })),
    {
      name: 'rightRemote',
      file: 'src/other.js',
      line: 1,
      code: 'function rightRemote(items) { const sharedMarker = "right"; for (const item of items) consume(sharedMarker, item); return sharedMarker; }',
    },
    {
      name: 'bridgeLocalWithLongName',
      file: 'src/shared.js',
      line: 20,
      code: 'function bridgeLocalWithLongName(items) { const sharedMarker = "bridge"; for (const item of items) consume(sharedMarker, item); return sharedMarker; }',
    },
  ];
  const originalSimilarity = Parser.codeSimilarity;
  Parser.codeSimilarity = (left, right) => {
    const pair = [left.match(/(leftLocal\d+|rightRemote|bridgeLocalWithLongName)/)?.[1], right.match(/(leftLocal\d+|rightRemote|bridgeLocalWithLongName)/)?.[1]].sort().join(':');
    if (pair === 'bridgeLocalWithLongName:rightRemote' || /bridgeLocalWithLongName:leftLocal\d+/.test(pair)) return 0.8;
    return 0.5;
  };

  let duplicates;
  try {
    duplicates = Parser.detectDuplicates([], functions).filter((duplicate) => duplicate.type === 'code');
  } finally {
    Parser.codeSimilarity = originalSimilarity;
  }

  assert.equal(
    duplicates.some((duplicate) => {
      const names = new Set(duplicate.files.map((file) => file.name));
      return names.has('rightRemote') && names.has('bridgeLocalWithLongName');
    }),
    true
  );
});

test('duplicate grouping bounds expensive similarity checks inside coarse buckets', () => {
  const { Parser } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const functions = Array.from({ length: 1000 }, (_, index) => ({
    name: `candidate${index}`,
    file: `src/${index}.js`,
    line: 1,
    code: `function candidate${index}(items) { const label = "candidate-${index}"; for (const item of items) { if (item.ok) consume(label, item.id); } return label; }`,
  }));
  const realDuplicates = Parser.detectDuplicates([], functions).filter((duplicate) => duplicate.type === 'code');
  const coherentGroup = realDuplicates.find((duplicate) => {
    const files = new Set(duplicate.files.map((file) => file.file));
    return files.has('src/0.js') && files.has('src/999.js');
  });

  assert.notEqual(coherentGroup, undefined);
  assert.equal(coherentGroup.count, 2);

  const originalSimilarity = Parser.codeSimilarity;
  let comparisons = 0;
  Parser.codeSimilarity = () => {
    comparisons += 1;
    return 0;
  };

  try {
    Parser.detectDuplicates([], functions);
  } finally {
    Parser.codeSimilarity = originalSimilarity;
  }

  assert.ok(comparisons <= 8000, `expected at most 8000 comparisons, received ${comparisons}`);
});

test('large mixed repositories index paths once and never call-scan non-code assets', async () => {
  const { Parser, buildAnalysisData } = loadAnalyzer(join(__dirname, '..', '..', 'src', 'codeflow', 'core.js'));
  const repeatedData = '{"snapshot":"targetCall()"}\n'.repeat(150);
  const analyzed = Array.from({ length: 3000 }, (_, index) => ({
    path: `artifacts/snapshot-${index}.json`,
    name: `snapshot-${index}.json`,
    folder: 'artifacts',
    content: repeatedData,
    functions: [],
    lines: 150,
    layer: 'data',
    churn: 0,
    isCode: false,
  }));

  const targetFn = {
    name: 'targetCall',
    file: 'src/target.js',
    folder: 'src',
    layer: 'utils',
    line: 1,
    code: 'export function targetCall() {}',
    isTopLevel: true,
    isExported: true,
    type: 'function',
  };
  analyzed.push(
    {
      path: 'src/target.js',
      name: 'target.js',
      folder: 'src',
      content: targetFn.code,
      functions: [targetFn],
      lines: 1,
      layer: 'utils',
      churn: 0,
      isCode: true,
    },
    {
      path: 'src/caller.js',
      name: 'caller.js',
      folder: 'src',
      content: "import { targetCall } from './target.js';\ntargetCall();",
      functions: [],
      lines: 2,
      layer: 'services',
      churn: 0,
      isCode: true,
    }
  );

  let pathIndexBuilds = 0;
  let callScans = 0;
  const originalBuildPathIndex = Parser.buildCallGraphPathIndex;
  const originalFindCalls = Parser.findCalls;
  Parser.buildCallGraphPathIndex = function(files) {
    pathIndexBuilds += 1;
    return originalBuildPathIndex.call(Parser, files);
  };
  Parser.findCalls = function(...args) {
    callScans += 1;
    return originalFindCalls.apply(Parser, args);
  };

  const started = Date.now();
  const data = await buildAnalysisData({
    analyzed,
    allFns: [targetFn],
    progress() {},
    yieldFn: async () => {},
  });
  const durationMs = Date.now() - started;

  assert.equal(pathIndexBuilds, 1, 'the repository path map should be built once');
  assert.equal(callScans, 2, 'only actual code files should enter call analysis');
  assert.equal(
    data.connections.some((connection) =>
      connection.source === 'src/target.js' && connection.target === 'src/caller.js'
    ),
    true,
    'indexed import resolution should preserve dependency edges'
  );
  // Wall-clock guard only: CI runners can spike ~2s on this 3k-file fixture.
  // The path-index and call-scan counts above catch a real analysis regression.
  // Loose enough for a loaded laptop or a shared CI runner; a quadratic regression is still an order of magnitude over it.
  assert.ok(durationMs < 12000, `synthetic 3k-file analysis took ${durationMs}ms`);
});
