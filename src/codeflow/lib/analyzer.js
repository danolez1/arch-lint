// Run the codeflow analyzer (core.js, lifted unchanged from codeflow's index.html)
// in a Node vm context.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const START_MARKER = '// ===== CODEFLOW_ANALYZER_START =====';
const END_MARKER = '// ===== CODEFLOW_ANALYZER_END =====';
const METRICS_START = '// ===== CODEFLOW_METRICS_START =====';
const METRICS_END = '// ===== CODEFLOW_METRICS_END =====';

function sliceBlock(html, startMarker, endMarker, label) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    throw new Error(
      'Could not locate ' + label + ' block. Expected ' + startMarker + ' / ' + endMarker + '.'
    );
  }
  return html.slice(start, end);
}

function loadAnalyzer(sourcePath) {
  const html = fs.readFileSync(sourcePath, 'utf8');
  const analyzerSource = sliceBlock(html, START_MARKER, END_MARKER, 'analyzer');
  const metricsSource = sliceBlock(html, METRICS_START, METRICS_END, 'metrics');

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
  vm.createContext(context, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });
  const exposeExports =
    '\nthis.Parser = Parser;' +
    '\nthis.buildAnalysisData = buildAnalysisData;' +
    '\nthis.calcBlast = calcBlast;' +
    '\nthis.calcHealth = calcHealth;';
  const script = new vm.Script(analyzerSource + '\n' + metricsSource + exposeExports, {
    filename: 'codeflow-analyzer.js',
  });
  script.runInContext(context, { timeout: 1000 });

  return {
    Parser: context.Parser,
    buildAnalysisData: context.buildAnalysisData,
    calcBlast: context.calcBlast,
    calcHealth: context.calcHealth,
  };
}

function locateCoreSource() {
  // Always load the analyzer shipped with this package, never from the repository being analyzed.
  const core = path.resolve(__dirname, '..', 'core.js');
  if (fs.existsSync(core)) return core;
  throw new Error('Could not find CodeFlow analyzer source at ' + core + '.');
}

module.exports = { loadAnalyzer, locateCoreSource, START_MARKER, END_MARKER };
