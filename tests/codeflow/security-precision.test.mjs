import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..', '..', 'src', 'codeflow');
const htmlSource = await readFile(join(repoRoot, 'core.js'), 'utf8');
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
  `${htmlSource.slice(parserStart, parserEnd)}\nthis.Parser = Parser; this.buildAnalysisData = buildAnalysisData;`,
  context
);

const { Parser, buildAnalysisData } = context;

async function collectFixtureFiles(root) {
  const files = [];

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !Parser.isIncluded(entry.name)) continue;
      const repoPath = relative(root, fullPath).replace(/\\/g, '/');
      files.push({
        fullPath,
        path: repoPath,
        name: basename(repoPath),
        folder: repoPath.includes('/') ? repoPath.slice(0, repoPath.lastIndexOf('/')) : 'root',
        isCode: Parser.isCode(entry.name),
      });
    }
  }

  await walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function analyzeFixture(name) {
  const root = join(__dirname, 'fixtures', name);
  const files = await collectFixtureFiles(root);
  const analyzed = [];
  const allFns = [];

  for (const file of files) {
    const content = await readFile(file.fullPath, 'utf8');
    const layer = Parser.detectLayer(file.path);
    const actualIsCode = file.isCode !== false && (!Parser.isScriptContainer(file.path) || Parser.hasEmbeddedCode(content, file.path));
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
      functions.forEach((fn) => allFns.push(Object.assign({}, fn, { folder: file.folder, layer })));
    }
  }

  return buildAnalysisData({
    analyzed,
    allFns,
    excludePatterns: [],
    progress() {},
    yieldFn: async () => {},
  });
}

async function analyzeSyntheticFiles(fileDescs) {
  const analyzed = [];
  const allFns = [];

  for (const file of fileDescs) {
    const path = file.path;
    const name = basename(path);
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'root';
    const content = file.content;
    const layer = Parser.detectLayer(path);
    const actualIsCode = Parser.isCode(name) !== false && (!Parser.isScriptContainer(path) || Parser.hasEmbeddedCode(content, path));
    const functions = actualIsCode ? Parser.extract(content, path) : [];
    analyzed.push({
      path,
      name,
      folder,
      content,
      functions,
      lines: content ? content.split('\n').length : 0,
      layer,
      churn: 0,
      isCode: actualIsCode,
    });
    if (actualIsCode) {
      functions.forEach((fn) => allFns.push(Object.assign({}, fn, { folder, layer })));
    }
  }

  return buildAnalysisData({
    analyzed,
    allFns,
    excludePatterns: [],
    progress() {},
    yieldFn: async () => {},
  });
}

test('Hardcoded Secret rule excludes test stubs, keeps real hits', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Hardcoded Secret')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('test/client-ip.test.ts'), false);
  assert.equal(flaggedPaths.includes('lib/auth.ts'), true);
});

test('Hardcoded Secret rule still applies to executable infrastructure paths', async () => {
  // Fixture lines are assembled at runtime so this test file never contains a
  // literal credential-shaped string (fake values only, for the analyzer regex).
  const credentialLine = (keyword, fakeValue) => `${keyword} = "${fakeValue}"\n`;
  const data = await analyzeSyntheticFiles([
    { path: '.github/workflows/notify.js', content: `const ${credentialLine('api_key', 'fixture-ci-value-1234')}` },
    { path: '.claude/hooks/session-start.py', content: credentialLine('password', 'fixture-hook-value-1234') },
    { path: 'scripts/provision.py', content: credentialLine('token', 'fixture-script-value-1234') },
    { path: 'docs/setup.md', content: credentialLine('password', 'fixture-doc-value-1234') },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Hardcoded Secret')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('.github/workflows/notify.js'), true);
  assert.equal(flaggedPaths.includes('.claude/hooks/session-start.py'), true);
  assert.equal(flaggedPaths.includes('scripts/provision.py'), true);
  assert.equal(flaggedPaths.includes('docs/setup.md'), false);
});

test('Hardcoded Secret rule ignores labels, storage keys, environment expansion, and placeholders', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'app/routes.dart', content: "static const password = '/settings/password';\n" },
    { path: 'app/storage.dart', content: "static const accessToken = 'vellum_access_token';\n" },
    { path: 'infra/restore.sh', content: 'export PGPASSWORD="${DATABASE_PASSWORD:?required}"\n' },
    { path: 'scripts/openapi.ts', content: 'const JWT_SECRET = "openapi-placeholder-signing-key-32-characters";\n' },
    { path: 'lib/labels.ts', content: 'const auth = "Authentication";\n' },
    { path: 'lib/pairing.ts', content: 'const pairingAuthority = "UNKNOWN";\n' },
    { path: 'lib/header.ts', content: 'const INTERNAL_SECRET_HEADER = "X-Internal-Secret";\n' },
    { path: 'lib/audit.ts', content: 'const TEMP_ACCESS_TOKEN_CREATED = "temp_access.token.created";\n' },
    { path: 'lib/pattern.ts', content: 'const SIZE_TOKEN = "(\\\\d+|\\\\[\\\\d+px\\\\])";\n' },
    { path: 'scripts/backup.sh', content: 'export AWS_SECRET_ACCESS_KEY="$B2_ACCOUNT_KEY"\n' },
    { path: 'server/live.ts', content: 'const AUTH_SECRET = "hardcoded-value-9f8e7d6c";\n' },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Hardcoded Secret')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('app/routes.dart'), false);
  assert.equal(flaggedPaths.includes('app/storage.dart'), false);
  assert.equal(flaggedPaths.includes('infra/restore.sh'), false);
  assert.equal(flaggedPaths.includes('scripts/openapi.ts'), false);
    assert.equal(flaggedPaths.includes('lib/labels.ts'), false);
    assert.equal(flaggedPaths.includes('lib/pairing.ts'), false);
  assert.equal(flaggedPaths.includes('lib/header.ts'), false);
  assert.equal(flaggedPaths.includes('lib/audit.ts'), false);
  assert.equal(flaggedPaths.includes('lib/pattern.ts'), false);
  assert.equal(flaggedPaths.includes('scripts/backup.sh'), false);
  assert.equal(flaggedPaths.includes('server/live.ts'), true);
});

test('Hardcoded Secret rule keeps short, alphabetic, and adversarial credential values', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'server/short.ts', content: 'const password = "aB3!xyz";\n' },
    { path: 'server/alpha.ts', content: 'const token = "correcthorsebattery";\n' },
    { path: 'server/passphrase.ts', content: 'const password = "correct horse battery staple";\n' },
    { path: 'server/numeric.ts', content: 'const password = "73910482";\n' },
    { path: 'server/auth-value.ts', content: 'const AuthValue = "realcredential123";\n' },
    { path: 'server/authorization.ts', content: 'const authorization = "realcredential123";\n' },
    { path: 'server/adversarial.ts', content: 'const apiKey = "prod-example-9f8e7d6c";\n' },
    { path: 'server/placeholder.ts', content: 'const apiKey = "example-token-value";\n' },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Hardcoded Secret')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('server/short.ts'), true);
    assert.equal(flaggedPaths.includes('server/alpha.ts'), true);
    assert.equal(flaggedPaths.includes('server/passphrase.ts'), true);
    assert.equal(flaggedPaths.includes('server/numeric.ts'), true);
    assert.equal(flaggedPaths.includes('server/auth-value.ts'), true);
    assert.equal(flaggedPaths.includes('server/authorization.ts'), true);
  assert.equal(flaggedPaths.includes('server/adversarial.ts'), true);
  assert.equal(flaggedPaths.includes('server/placeholder.ts'), false);
});

test('Hardcoded Secret rule excludes metadata fields and whole-value fixture credentials', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'lib/session.ts', content: 'const tokenStorage = "server-side";\n' },
    { path: 'lib/types.ts', content: 'const accessTokenType = "OIDC_TOKEN_TYPE_JWT";\n' },
    { path: 'lib/auth.ts', content: 'const AUTH_SCHEME_PREFIX = "Bearer ";\n' },
    { path: 'lib/env.ts', content: 'const ApiKeyEnvironment = "live";\n' },
    { path: 'infra/flags.yml', content: 'PASSWORDCHANGEREQUIRED: "false"\n' },
    { path: 'tools/openapi.ts', content: 'const INTERNAL_SERVICE_SECRET = "dummy-secret-for-openapi-export-32chars";\n' },
    { path: 'scripts/contract.ts', content: 'const JWT_SECRET = "placeholder-isolated-contract-test-signing-key-32";\n' },
    {
      path: 'tools/export-openapi.ts',
      content: 'const DUMMY_ENV: Record<string, string> = {\n  MINIO_SECRET_KEY: "minioadmin",\n  INTERNAL_SERVICE_SECRET: "schema-only-value",\n};\n',
    },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Hardcoded Secret')
    .map((i) => i.path);

  assert.equal(flaggedPaths.length, 0);
});

test('Shell Injection Risk rule excludes dev tooling, keeps real hits', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Shell Injection Risk')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('.claude/hooks/pre-commit.py'), false);
  assert.equal(flaggedPaths.includes('api/import.py'), true);
});

test('Command Execution rule excludes regex.exec(), keeps child_process.exec()', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Command Execution')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('lib/search.ts'), false);
  assert.equal(flaggedPaths.includes('lib/runner.ts'), true);
});

test('Command Execution rule detects node: specifier on child_process import and require', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Command Execution')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('server/logger.ts'), true);
});

test('Command Execution rule requires an unsafe call, not an unused child_process import', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'server/spawner.ts',
      content: 'const cp=require("node:child_process");\n',
    },
    {
      path: 'server/runner.ts',
      content: 'const cp=require("node:child_process");\ncp.exec(userInput);\n',
    },
    {
      path: 'server/unzip.ts',
      content: 'import { execFileSync } from "node:child_process";\nexecFileSync("unzip", [archive]);\n',
    },
    {
      path: 'server/inline.ts',
      content: 'require("node:child_process").exec(userInput);\n',
    },
    {
      path: 'server/namespace.ts',
      content: 'import * as runner from "node:child_process";\nrunner.exec(userInput);\n',
    },
    {
      path: 'server/assigned.ts',
      content: 'const runner = require("child_process");\nrunner.exec(userInput);\n',
    },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Command Execution')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('server/spawner.ts'), false);
  assert.equal(flaggedPaths.includes('server/runner.ts'), true);
  assert.equal(flaggedPaths.includes('server/unzip.ts'), false);
  assert.equal(flaggedPaths.includes('server/inline.ts'), true);
  assert.equal(flaggedPaths.includes('server/namespace.ts'), true);
  assert.equal(flaggedPaths.includes('server/assigned.ts'), true);
});

test('SQL Injection Risk rule excludes markdown prose, keeps real template injection', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'SQL Injection Risk')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('docs/decisions.md'), false);
  assert.equal(flaggedPaths.includes('lib/db.ts'), true);
});

test('SQL Injection Risk rule catches a vulnerable second db call after a safe first call', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'SQL Injection Risk')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('lib/db.ts'), true);
});

test('SQL Injection Risk distinguishes parameterized SQL tags and HTTP raw calls', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'models/safe-query.ts',
      content: 'export async function load(id) { return db.execute(sql`SELECT * FROM users WHERE id = ${id}`); }\n',
    },
    {
      path: 'clients/http.ts',
      content: 'export async function remove(id) { return client.raw("DELETE", `/items/${id}`); }\n',
    },
    {
      path: 'models/unsafe-query.ts',
      content: 'export async function remove(id) { return db.execute(`DELETE FROM users WHERE id = ${id}`); }\n',
    },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'SQL Injection Risk')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('models/safe-query.ts'), false);
  assert.equal(flaggedPaths.includes('clients/http.ts'), false);
  assert.equal(flaggedPaths.includes('models/unsafe-query.ts'), true);
});

test('SQL Injection Risk ignores test fixtures while retaining the same production pattern', async () => {
  const unsafe = 'export async function remove(id) { return db.execute(`DELETE FROM users WHERE id = ${id}`); }\n';
  const data = await analyzeSyntheticFiles([
    { path: 'tests/integration/db.test.ts', content: unsafe },
    { path: 'models/unsafe-query.ts', content: unsafe },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'SQL Injection Risk')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('tests/integration/db.test.ts'), false);
  assert.equal(flaggedPaths.includes('models/unsafe-query.ts'), true);
});

test('XSS Vulnerability rule excludes static literals, keeps variable interpolation', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'XSS Vulnerability')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('app/page.tsx'), false);
  assert.equal(flaggedPaths.includes('app/profile-card.tsx'), true);
});

test('XSS Vulnerability rule still catches a dangerous occurrence after a safe literal in the same file', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'XSS Vulnerability')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('app/mixed-render.tsx'), true);
});

test('XSS Vulnerability rule accepts JSON-LD serialized with less-than escaping', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'app/json-ld.tsx',
      content: 'export function JsonLd({ data }) { return <script dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\\\u003c") }} />; }\n',
    },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'XSS Vulnerability')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('app/json-ld.tsx'), false);
});

test('XSS Vulnerability rule accepts an explicit reviewed trusted-HTML boundary', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'app/highlight.tsx',
      content: '// codeflow-security: trusted-html, syntax highlighter escapes source.\nexport function View({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }\n',
    },
    {
      path: 'app/unsafe.tsx',
      content: 'export function View({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }\n',
    },
    {
      path: 'app/mixed-reviewed.tsx',
      content: '// codeflow-security: trusted-html, syntax highlighter escapes source.\nexport function Reviewed({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }\nexport function Unsafe({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }\n',
    },
  ]);

  assert.equal(
    data.securityIssues.some((i) => i.title === 'XSS Vulnerability' && i.path === 'app/highlight.tsx'),
    false
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'XSS Vulnerability' && i.path === 'app/unsafe.tsx'),
    true
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'XSS Vulnerability' && i.path === 'app/mixed-reviewed.tsx'),
    true
  );
});

test('Function Constructor rule excludes substring mentions, keeps real constructor calls', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Function Constructor')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('lib/csp.ts'), false);
  assert.equal(flaggedPaths.includes('lib/dynamic.ts'), true);
});

test('Function Constructor rule flags bare Function() and new Function(), not identifiers like getFunction()', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'lib/factory.ts', content: 'export function make(src: string) {\n  return Function(src);\n}\n' },
    { path: 'lib/builder.ts', content: 'export function build(src: string) {\n  return new Function(src);\n}\n' },
    { path: 'lib/reflection.ts', content: 'export function lookup(name: string) {\n  return getFunction(name);\n}\n' },
  ]);
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'Function Constructor')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('lib/factory.ts'), true);
  assert.equal(flaggedPaths.includes('lib/builder.ts'), true);
  assert.equal(flaggedPaths.includes('lib/reflection.ts'), false);
});

test('JavaScript execution rules ignore Dart callback types and member eval methods', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'mobile/uploader.dart',
      content: 'final Future<void> Function() upload;\n',
    },
    {
      path: 'cache/rate-limit.ts',
      content: 'export async function run(client) { return client.eval("return redis.call(\\"GET\\", KEYS[1])", []); }\n',
    },
    {
      path: 'lib/unsafe-eval.ts',
      content: 'export function run(source) { return eval(source); }\n',
    },
  ]);

  assert.equal(
    data.securityIssues.some((i) => i.title === 'Function Constructor' && i.path === 'mobile/uploader.dart'),
    false
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'Dynamic Code Execution' && i.path === 'cache/rate-limit.ts'),
    false
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'Dynamic Code Execution' && i.path === 'lib/unsafe-eval.ts'),
    true
  );
});

test('JavaScript execution rules ignore comments and static template text but scan template expressions', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'lib/policy.ts',
      content: '// eval() is prohibited here\nconst sample = "Function(source)";\n',
    },
    {
      path: 'lib/live.ts',
      content: 'export function run(source) { return Function(source); }\n',
    },
    {
      path: 'lib/template-text.ts',
      content: 'const policy = `eval(source) and Function(source) are prohibited`;\n',
    },
    {
      path: 'lib/template-expression.ts',
      content: 'export function run(source) { return `${eval(source)}`; }\n',
    },
  ]);

  assert.equal(
    data.securityIssues.some((i) => i.title === 'Dynamic Code Execution' && i.path === 'lib/policy.ts'),
    false
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'Function Constructor' && i.path === 'lib/policy.ts'),
    false
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'Function Constructor' && i.path === 'lib/live.ts'),
    true
  );
  assert.equal(
    data.securityIssues.some((i) => /Dynamic Code Execution|Function Constructor/.test(i.title) && i.path === 'lib/template-text.ts'),
    false
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'Dynamic Code Execution' && i.path === 'lib/template-expression.ts'),
    true
  );
});

test('VBA Shell detection ignores application identifiers in non-VBA files', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'admin/shell.tsx', content: 'export function PublicShell() { return <main />; }\n' },
    { path: 'macros/run.bas', content: 'Sub RunReport()\n  Shell("calc.exe")\nEnd Sub\n' },
  ]);

  assert.equal(
    data.securityIssues.some((i) => i.title === 'Shell Command Execution' && i.path === 'admin/shell.tsx'),
    false
  );
  assert.equal(
    data.securityIssues.some((i) => i.title === 'Shell Command Execution' && i.path === 'macros/run.bas'),
    true
  );
});

test('Debug Statements rule downgrades server-only code, keeps client code at low', async () => {
  const data = await analyzeFixture('security-precision-world');
  const serverIssue = data.securityIssues.find((i) => i.title === 'Debug Statements' && i.path === 'server/logger.ts');
  const clientIssue = data.securityIssues.find((i) => i.title === 'Debug Statements' && i.path === 'components/dashboard.tsx');

  assert.equal(serverIssue.severity, 'info');
  assert.equal(clientIssue.severity, 'low');
});

test('Code Comments rule reports actionable comment markers without matching marker substrings', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'src/todo.ts', content: '// TODO replace temporary fallback\nexport const fallback = true;\n' },
    { path: 'src/fix.py', content: '# FIXME(owner) handle malformed input\nvalue = 1\n' },
    { path: 'src/hack.ts', content: '/* HACK: remove after upstream release */\nexport const workaround = true;\n' },
    { path: 'src/hackathon.ts', content: 'export const HACKATHON = "active";\n' },
    { path: 'src/prose.ts', content: '/**\n * This is deliberately not a\n * TODO. Inventory stays documented.\n */\nexport const documented = true;\n' },
    { path: 'scripts/temp.sh', content: 'temporary_path="bundle.XXXXXX"\n' },
    { path: 'docs/error.md', content: 'The scanner fixture uses ErrorCode.XXX.\n' },
  ]);
  const flaggedPaths = Array.from(
    data.securityIssues.filter((issue) => issue.title === 'Code Comments'),
    (issue) => issue.path
  ).sort();

  assert.deepEqual(flaggedPaths, ['src/fix.py', 'src/hack.ts', 'src/todo.ts']);
});

test('security issue sort places info strictly after high/medium/low with no NaN corruption', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'server/telemetry.ts', content: 'console.log(1);console.log(2);console.log(3);console.log(4);\n' },
    { path: 'app/widget.ts', content: 'var f=new Function("return 1;");\n' },
    { path: 'lib/db-query.ts', content: 'function findUser(id){ return db.query(`SELECT * FROM users WHERE id = ${id}`); }\n' },
  ]);
  const rank = { high: 0, medium: 1, low: 2, info: 3 };
  const severities = Array.from(data.securityIssues, (i) => i.severity);

  assert.deepEqual(severities, ['high', 'medium', 'info']);
  for (let i = 1; i < severities.length; i++) {
    assert.ok(
      rank[severities[i - 1]] <= rank[severities[i]],
      'security issues must be sorted by non-decreasing severity rank (high, medium, low, info)'
    );
  }
});

test('Duplicate names: Next.js POST route handlers are not flagged as a naming conflict', async () => {
  const data = await analyzeFixture('security-precision-world');
  const postNameDup = data.duplicates.find((d) => d.type === 'name' && d.name === 'POST');

  assert.equal(postNameDup, undefined);
});

test('XSS Vulnerability rule excludes dangerouslySetInnerHTML in non-production paths, even with variable interpolation', async () => {
  const data = await analyzeFixture('security-precision-world');
  const flaggedPaths = data.securityIssues
    .filter((i) => i.title === 'XSS Vulnerability')
    .map((i) => i.path);

  assert.equal(flaggedPaths.includes('preview-guard.md'), false);
  assert.equal(flaggedPaths.includes('app/profile-card.tsx'), true);
});

test('Duplicate code: structural duplicates are still detected across non-production paths', async () => {
  const duplicateFn = [
    'function processDataAlpha(items){',
    '    var result=[];',
    '    for(var i=0;i<items.length;i++){',
    '        if(items[i]>0){',
    '            result.push(items[i]*2);',
    '        }',
    '    }',
    '    return result;',
    '}',
    '',
  ].join('\n');
  const data = await analyzeSyntheticFiles([
    { path: 'tests/helpers/a.ts', content: duplicateFn },
    { path: 'tools/b.ts', content: duplicateFn.replace('processDataAlpha', 'processDataBeta') },
  ]);

  const codeDup = data.duplicates.find(
    (d) => d.type === 'code' && d.files.some((f) => f.file === 'tests/helpers/a.ts') && d.files.some((f) => f.file === 'tools/b.ts')
  );

  assert.notEqual(codeDup, undefined);
});

test('dead-code analysis recognizes k6 and HTMLParser callback entry points', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'tools/load/scenario.k6.js',
      content: 'export const options={scenarios:{probe:{exec:"probe"}}};\nexport function probe(){ return 1; }\n',
    },
    {
      path: 'scripts/verify.sh',
      content: "python3 <<'PY'\nfrom html.parser import HTMLParser\nclass Links(HTMLParser):\n    def handle_starttag(self, tag, attrs):\n        pass\nPY\n",
    },
  ]);

  assert.equal(data.deadFunctions.some((fn) => fn.name === 'probe'), false);
  assert.equal(data.deadFunctions.some((fn) => fn.name === 'handle_starttag'), false);
});

test('JavaScript fallback ignores awaited calls with callback arrows', () => {
  const functions = Parser.extract(
    [
      'await retryBootStep("First", () =>',
      '  initialize({ enabled: true })',
      ');',
      '',
      'await retryBootStep("Second", async () => {',
      '  await load();',
      '});',
      '',
    ].join('\n'),
    'src/index.ts'
  );

  assert.equal(functions.length, 0);
});

test('JavaScript fallback preserves nested declaration scope', () => {
  const functions = Parser.extract(
    [
      'function createHandler() {',
      '  function readCookie() { return "session"; }',
      '  const onMove = () => readCookie();',
      '  return onMove;',
      '}',
      '',
    ].join('\n'),
    'src/session.ts'
  );

  assert.equal(functions.find((fn) => fn.name === 'createHandler')?.isTopLevel, true);
  assert.equal(functions.find((fn) => fn.name === 'readCookie')?.isTopLevel, false);
  assert.equal(functions.find((fn) => fn.name === 'onMove')?.isTopLevel, false);
});

test('JavaScript fallback does not extract control-flow blocks as methods', () => {
  const functions = Parser.extract(
    [
      'function processItems(items) {',
      '  for (const item of items) { consume(item); }',
      '  if (items.length > 0) { return items[0]; }',
      '  while (items.length > 10) { items.pop(); }',
      '  switch (items.length) { default: break; }',
      '  try { consume(items); } catch (error) { report(error); }',
      '}',
      '',
    ].join('\n'),
    'src/processor.ts'
  );

  assert.deepEqual(Array.from(functions, (fn) => fn.name), ['processItems']);
});

test('JavaScript fallback ignores function-like text in comments and strings', () => {
  const functions = Parser.extract(
    [
      '// function lineCommentFake() {}',
      '/* function blockCommentFake() {} */',
      'const singleQuoted = \'function singleQuotedFake() {}\';',
      'const doubleQuoted = "function doubleQuotedFake() {}";',
      'const templateText = `function templateTextFake() {}`;',
      'function realHandler() { return true; }',
      '',
    ].join('\n'),
    'src/processor.ts'
  );

  assert.deepEqual(Array.from(functions, (fn) => fn.name), ['realHandler']);
});

test('JavaScript masking preserves code after regular-expression literals', async () => {
  const content = [
    'const quotedCharacter = /["\']/;',
    'function visibleHandler() { return true; }',
    'eval(userCode);',
    '',
  ].join('\n');
  const functions = Parser.extract(content, 'src/processor.ts');
  const data = await analyzeSyntheticFiles([{ path: 'src/processor.ts', content }]);

  assert.deepEqual(Array.from(functions, (fn) => fn.name), ['visibleHandler']);
  assert.equal(data.securityIssues.some((issue) => issue.title === 'Dynamic Code Execution'), true);
});

test('dead-code analysis recognizes JavaScript first-class references', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'src/catalog.ts',
      content: [
        'function fetchCatalogBytes() { return new Uint8Array(); }',
        'export function loadCatalog(options = {}) {',
        '  const fetchBytes = options.fetchBytes ?? fetchCatalogBytes;',
        '  return fetchBytes();',
        '}',
        '',
      ].join('\n'),
    },
  ]);

  assert.equal(data.deadFunctions.some((fn) => fn.name === 'fetchCatalogBytes'), false);
});

test('dead-code analysis excludes generated runtime artifacts', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'public/draco/draco_decoder.js',
      content: 'function ___wasm_call_ctors() { return 1; }\n',
    },
    {
      path: 'src/manual.js',
      content: 'function unusedManualHelper() { return 1; }\n',
    },
  ]);

  assert.equal(data.deadFunctions.some((fn) => fn.name === '___wasm_call_ctors'), false);
  assert.equal(data.deadFunctions.some((fn) => fn.name === 'unusedManualHelper'), true);
});

test('dead-code analysis recognizes framework entries and textually exported helpers', async () => {
  const data = await analyzeSyntheticFiles([
    {
      path: 'app/account/page.tsx',
      content: 'export default function AccountPage(){ return <main />; }\n',
    },
    {
      path: 'api/routes/items.py',
      content: '@router.get(\n    "/items",\n    response_model=list[Item],\n    dependencies=[Depends(auth)],\n)\nasync def list_items():\n    return []\n',
    },
    {
      path: 'lib/helpers.ts',
      content: 'export const makeValue = () => 1;\n',
    },
  ]);

  assert.equal(data.deadFunctions.some((fn) => fn.name === 'AccountPage'), false);
  assert.equal(data.deadFunctions.some((fn) => fn.name === 'list_items'), false);
  assert.equal(data.deadFunctions.some((fn) => fn.name === 'makeValue'), false);
});
