// Walk a repo and collect file content + parsed functions, mirroring the shape
// the analyzer expects (see tests/codeflow-golden.test.mjs analyzeFixture).

'use strict';

const fs = require('fs');
const path = require('path');

const { matchesExcludePattern } = require('./exclude.js');

const DEFAULT_IGNORES = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'out',
  'coverage',
  '.cache',
  '.parcel-cache',
  '.turbo',
  '.vercel',
  '.local',
  '.artifacts',
  '.playwright-cli',
  'playwright-report',
  'test-results',
  '.claude',
  '.codex',
  '.idea',
  '.vscode',
  '.pnpm-store',
  '.yarn',
  'tmp',
  'temp',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'bin',
  'obj',
]);

function walk(root, current, files, Parser, excludePatterns) {
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    if (DEFAULT_IGNORES.has(entry.name.toLowerCase())) continue;
    const full = path.join(current, entry.name);
    const repoPath = path.relative(root, full).split(path.sep).join('/');
    // Prune excluded paths during the walk — exclusion must happen before
    // Parser.extract/buildAnalysisData ever see the files, or huge vendored
    // trees (minified bundles, absorbed third-party code) blow the analysis
    // phase up from seconds to hours.
    if (matchesExcludePattern(excludePatterns, repoPath, entry.name)) continue;
    if (entry.isDirectory()) {
      walk(root, full, files, Parser, excludePatterns);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!Parser.isIncluded(entry.name)) continue;
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      // A racing filesystem change will be handled by the read step.
    }
    files.push({
      fullPath: full,
      path: repoPath,
      name: path.basename(repoPath),
      folder: repoPath.includes('/') ? repoPath.slice(0, repoPath.lastIndexOf('/')) : 'root',
      isCode: Parser.isCode(entry.name),
      size,
    });
  }
}

async function buildAnalyzed(repoRoot, Parser, excludePatterns) {
  const files = [];
  walk(repoRoot, repoRoot, files, Parser, excludePatterns || []);
  files.sort((a, b) => a.path.localeCompare(b.path));

  const analyzed = [];
  const allFns = [];
  for (const file of files) {
    const layer = Parser.detectLayer(file.path);
    if (Parser.isOversized(file.size)) {
      analyzed.push({
        path: file.path,
        name: file.name,
        folder: file.folder,
        content: '',
        functions: [],
        lines: 0,
        layer,
        churn: 0,
        isCode: file.isCode,
        size: file.size,
        analysisSkipped: 'oversized',
        parserProvenance: 'skipped:size-limit',
      });
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(file.fullPath, 'utf8');
    } catch {
      continue;
    }
    const isContainer = Parser.isScriptContainer(file.path);
    const actualIsCode =
      file.isCode !== false && (!isContainer || Parser.hasEmbeddedCode(content, file.path));
    const functions = actualIsCode ? Parser.extract(content, file.path) : [];
    analyzed.push({
      path: file.path,
      name: file.name,
      folder: file.folder,
      content,
      functions,
      lines: content ? content.split('\n').length : 0,
      layer,
      churn: 0,
      isCode: actualIsCode,
    });
    if (actualIsCode) {
      for (const fn of functions) {
        allFns.push(Object.assign({}, fn, { folder: file.folder, layer }));
      }
    }
  }
  return { analyzed, allFns };
}

module.exports = { buildAnalyzed };
