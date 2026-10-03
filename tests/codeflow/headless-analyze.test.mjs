import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..', '..', 'src', 'codeflow');
const fixtureRoot = join(__dirname, 'fixtures', 'golden-world');
const { analyze } = require('../../src/codeflow/lib/analysis.js');

test('headless analyzer returns a versioned data and snapshot envelope', async () => {
  const result = await analyze({ repoRoot: fixtureRoot });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.data.stats.files, 6);
  assert.equal(result.data.stats.functions, 7);
  assert.equal(result.snapshot.files, result.data.stats.files);
  assert.equal(result.snapshot.functions, result.data.stats.functions);
  assert.equal(typeof result.snapshot.grade, 'string');
});

test('headless analyzer applies repeated exclude patterns', async () => {
  const result = await analyze({ repoRoot: fixtureRoot, exclude: ['src/math.js', '*.md'] });

  assert.equal(result.data.files.some((file) => file.path === 'src/math.js'), false);
  assert.equal(result.data.files.some((file) => file.path.endsWith('.md')), false);
  assert.deepEqual(result.data.excludePatterns, ['src/math.js', '*.md']);
});

test('headless analyzer rejects missing paths and regular files', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'codeflow-invalid-root-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const filePath = join(fixture, 'file.js');
  await writeFile(filePath, 'export function example() {}\n');

  await assert.rejects(
    analyze({ repoRoot: join(fixture, 'missing') }),
    /Analysis path does not exist/
  );
  await assert.rejects(analyze({ repoRoot: filePath }), /Analysis path is not a directory/);
});

test(
  'headless analyzer rejects unreadable directories',
  { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) },
  async (t) => {
    const fixture = await mkdtemp(join(tmpdir(), 'codeflow-unreadable-root-'));
    t.after(async () => {
      await chmod(fixture, 0o700);
      await rm(fixture, { recursive: true, force: true });
    });
    await chmod(fixture, 0o000);

    await assert.rejects(analyze({ repoRoot: fixture }), /Analysis path is not readable/);
  }
);

test('headless collection prunes dependencies, caches, and local worktrees by default', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'codeflow-headless-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, 'vendor'), { recursive: true });
  await mkdir(join(fixture, '.local', 'worktrees', 'copy'), { recursive: true });
  await mkdir(join(fixture, '.turbo', 'cache'), { recursive: true });
  await mkdir(join(fixture, '.claude', 'worktrees', 'copy'), { recursive: true });
  await writeFile(join(fixture, 'index.js'), 'export function included() { return true; }\n');
  await writeFile(join(fixture, 'vendor', 'ignored.js'), 'export function ignored() { return false; }\n');
  await writeFile(join(fixture, '.local', 'worktrees', 'copy', 'ignored.js'), 'export function ignoredLocal() {}\n');
  await writeFile(join(fixture, '.turbo', 'cache', 'ignored.js'), 'export function ignoredCache() {}\n');
  await writeFile(join(fixture, '.claude', 'worktrees', 'copy', 'ignored.js'), 'export function ignoredWorktree() {}\n');
  await writeFile(join(fixture, 'huge.json'), 'x'.repeat(2 * 1024 * 1024 + 1));

  const result = await analyze({ repoRoot: fixture });
  assert.deepEqual(result.data.files.map((file) => file.path), ['huge.json', 'index.js']);
  assert.equal(result.data.files[0].analysisSkipped, 'oversized');
  assert.equal(result.data.stats.skipped, 1);
});
