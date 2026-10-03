import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', 'src', 'codeflow');
const require = createRequire(import.meta.url);
const { locateCoreSource } = require('../../src/codeflow/lib/analyzer.js');
const { analyze } = require('../../src/codeflow/lib/analysis.js');

test('analyzer loads its own core.js', () => {
  assert.equal(locateCoreSource(), join(repoRoot, 'core.js'));
});

test('analyzer does not execute an index.html found in the repository being analyzed', async () => {
  const consumerRepo = await mkdtemp(join(tmpdir(), 'codeflow-consumer-'));
  try {
    await writeFile(join(consumerRepo, 'index.html'), '<script>throw new Error("owned")</script>');
    const result = await analyze({ repoRoot: consumerRepo });
    assert.equal(result.schemaVersion, 1);
  } finally {
    await rm(consumerRepo, { recursive: true, force: true });
  }
});
