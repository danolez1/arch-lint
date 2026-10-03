// Regression tests for the CodeFlow self-scan exemption in detectSecurity.
//
// Background (issue #91): when CodeFlow analyzes its own index.html, the
// security scanner used to flag its own detection patterns (eval(, innerHTML=,
// child_process literals, ...) because they exist as source text. The old
// content-surgery "fix" in getSecurityScanContent anchored on its own string
// literal and deleted ~43KB of unrelated analyzer code instead.
//
// The fix blanks the CODEFLOW_ANALYZER_START..END block out of the scan copy
// (preserving line numbers) inside detectSecurity, so every runtime
// (main thread, worker, card action) shares the same structural exemption.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', 'src', 'codeflow');
const htmlSource = await readFileSync(join(repoRoot, 'core.js'), 'utf8');
const startMarker = '// ===== CODEFLOW_ANALYZER_START =====';
const endMarker = '// ===== CODEFLOW_ANALYZER_END =====';
const parserStart = htmlSource.indexOf(startMarker);
const parserEnd = htmlSource.indexOf(endMarker, parserStart);

if (parserStart < 0 || parserEnd < 0) {
  throw new Error('Could not locate analyzer source in core.js');
}

const context = {
  console,
  TreeSitter: undefined,
  Babel: undefined,
  acorn: undefined,
  getSecurityScanContent(file) {
    return file && file.content ? file.content : '';
  },
  isSanitizedPreviewRenderer() {
    return false;
  },
};

vm.createContext(context);
vm.runInContext(
  `${htmlSource.slice(parserStart, parserEnd)}\nthis.Parser = Parser;`,
  context
);

const { Parser } = context;

function detectOn(files) {
  return Parser.detectSecurity(files.map(function (f) {
    return Object.assign({ isCode: true, content: '' }, f);
  }));
}

test('self-scan: analyzer block source produces no security findings', () => {
  // Synthetic standalone copy of just the analyzer block: pre-fix, the
  // scanner flagged its own detection literals here (issue #91).
  const synthetic =
    htmlSource.slice(htmlSource.indexOf(startMarker), htmlSource.indexOf(endMarker)) +
    endMarker + '\n';
  const issues = detectOn([{ name: 'index.html', path: 'index.html', content: synthetic }]);
  assert.equal(issues.length, 0, 'expected zero findings for analyzer source, got: ' +
    issues.map((i) => i.title).join(', '));
});

test('self-scan: analyzer-induced titles are gone from the real index.html report', () => {
  // These three originate exclusively from detectSecurity's own source text
  // (Shell( description strings, On Error Resume Next literals, TODO/FIXME
  // lists). Remaining advisories about the UI region (innerHTML assignments,
  // an eval() mention in a hint string) are out of scope for this fix.
  const issues = detectOn([{ name: 'index.html', path: 'index.html', content: htmlSource }]);
  const titles = new Set(issues.map((i) => i.title));
  assert.equal(titles.has('Shell Command Execution'), false);
  assert.equal(titles.has('Excessive Error Suppression'), false);
  assert.equal(titles.has('Code Comments'), false);
});

test('self-scan exemption preserves line numbers outside the analyzer block', () => {
  const pad = Array.from({ length: 40 }, (_, i) => '// filler line ' + (i + 1)).join('\n');
  // The analyzer block itself contains eval( literals; this synthetic copy
  // places an ADDITIONAL real finding after the END marker and checks that
  // its reported line matches the original content's line numbering.
  const tail = [
    'module.exports = function run(userInput) {',
    '  return eval(userInput);',
    '};',
  ].join('\n');
  const synthetic =
    pad + '\n' +
    htmlSource.slice(htmlSource.indexOf(startMarker), htmlSource.indexOf(endMarker)) +
    endMarker + '\n' + tail + '\n';
  const expectedEvalLine = synthetic.slice(0, synthetic.indexOf('return eval')).split('\n').length;
  const issues = detectOn([{ name: 'index.html', path: 'index.html', content: synthetic }]);
  const dynamic = issues.filter((i) => /Dynamic Code Execution|Python eval\(\)/.test(i.title));
  assert.ok(dynamic.length >= 1, 'expected the post-block eval() to be reported');
  for (const issue of dynamic) {
    assert.equal(issue.line, expectedEvalLine, 'reported line should match original numbering');
  }
});

test('non-CodeFlow files with trigger strings are still reported', () => {
  const issues = detectOn([
    { name: 'app.js', path: 'src/app.js', content: 'export function run(x){ return eval(x); }\n' },
  ]);
  assert.equal(issues.filter((i) => i.title === 'Dynamic Code Execution').length, 1);
});

test('a foreign index.html without analyzer markers is still fully scanned', () => {
  const issues = detectOn([
    { name: 'index.html', path: 'index.html', content: '<script>var x = eval(input);</script>\n' },
  ]);
  assert.equal(issues.filter((i) => i.title === 'Dynamic Code Execution').length, 1);
});
