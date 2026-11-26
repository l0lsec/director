// Shared helpers for gate checks. Every helper throws on failure; checks never print PASS themselves.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const desktop = join(root, 'apps', 'desktop');
export const fixturesDir = join(root, 'fixtures', 'media');
export const requireFromDesktop = createRequire(join(desktop, 'package.json'));

export function assert(cond, message) {
  if (!cond) throw new Error(`assertion failed: ${message}`);
}

export function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: opts.cwd ?? root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...opts.env }, input: opts.input, timeout: opts.timeout });
  if (opts.allowFail) return res;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${res.status}): ${(res.stderr || res.stdout || '').slice(-2000)}`);
  return res;
}

export function tmp(name) {
  const dir = join(tmpdir(), 'director-verify', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run vitest on the given files and require all tests pass and at least `min` ran. */
export function vitest(files, { min = 1, env, pattern } = {}) {
  const out = join(tmp('vitest-' + Math.random().toString(16).slice(2)), 'result.json');
  const res = sh('npx', ['vitest', 'run', ...files, ...(pattern ? ['-t', pattern] : []), '--reporter=json', `--outputFile=${out}`], { allowFail: true, env });
  assert(existsSync(out), `vitest produced no report: ${(res.stderr || '').slice(-1500)}`);
  const json = JSON.parse(readFileSync(out, 'utf8'));
  const failed = json.testResults.flatMap((f) => f.assertionResults.filter((a) => a.status === 'failed').map((a) => `${a.fullName}: ${(a.failureMessages || []).join(' ').slice(0, 400)}`));
  assert(json.numFailedTests === 0 && json.numFailedTestSuites === 0, `vitest failures (${json.numFailedTests}):\n${failed.join('\n')}\n${(res.stderr || '').slice(-800)}`);
  assert(json.numPassedTests >= min, `expected at least ${min} passing tests, got ${json.numPassedTests}`);
  return `tests passed: ${json.numPassedTests}`;
}

function newestMtime(dir) {
  let m = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) m = Math.max(m, newestMtime(p));
    else m = Math.max(m, statSync(p).mtimeMs);
  }
  return m;
}

/** Build the desktop app if sources are newer than the last build. */
export function ensureBuilt() {
  const out = join(desktop, 'out', 'main', 'index.js');
  const srcNewest = Math.max(newestMtime(join(desktop, 'src')), statSync(join(desktop, 'electron.vite.config.ts')).mtimeMs, ...['agent', 'engine', 'media', 'analysis', 'ai', 'library'].map((p) => newestMtime(join(root, 'packages', p, 'src'))));
  if (!existsSync(out) || statSync(out).mtimeMs < srcNewest) sh('npx', ['electron-vite', 'build'], { cwd: desktop });
  return out;
}

/** Launch the built Electron app under Playwright. Caller must close it. */
export async function launchApp({ env = {}, args = [] } = {}) {
  const { _electron } = await import('@playwright/test');
  // DIRECTOR_PACKAGED_APP=/path/Director.app runs the same check against the packaged build.
  const packaged = env.DIRECTOR_PACKAGED_APP ?? process.env.DIRECTOR_PACKAGED_APP;
  if (!packaged) ensureBuilt();
  const executablePath = packaged ? join(packaged, 'Contents', 'MacOS', 'Director') : requireFromDesktop('electron');
  const app = await _electron.launch({
    executablePath,
    args: packaged ? args : [join(desktop, 'out', 'main', 'index.js'), ...args],
    env: { ...process.env, DIRECTOR_TEST: '1', DIRECTOR_REPO_ROOT: root, ...env },
    timeout: 60_000,
  });
  return app;
}

export function ffprobe(path) {
  const res = sh('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path]);
  return JSON.parse(res.stdout);
}

export function fixture(name) {
  const p = join(fixturesDir, name);
  if (!existsSync(p)) sh('node', ['scripts/fixtures/make-fixtures.mjs']);
  assert(existsSync(p), `fixture ${name} missing after generation`);
  return p;
}

export function groundTruth() {
  return JSON.parse(readFileSync(join(root, 'fixtures', 'ground-truth.json'), 'utf8'));
}

/** CHECK names declared in a ledger (leaf-x.y.md or node-n.md). */
export function ledgerChecks(file, { includeAbandoned = false } = {}) {
  const text = readFileSync(join(root, '.unlazy', 'build', 'gates', file), 'utf8');
  const abandoned = new Set([...text.matchAll(/^ABANDON: (\S+) /gm)].map((m) => m[1]));
  const out = [];
  let gate = null;
  for (const line of text.split('\n')) {
    const g = /^- \[[ x]\] (\S+):/.exec(line);
    if (g) gate = g[1];
    const c = /^\s+CHECK: node scripts\/verify\/run\.mjs (\S+)/.exec(line);
    if (c && (includeAbandoned || !abandoned.has(gate))) out.push(c[1]);
  }
  return out;
}

/** Run every runnable check of the given leaves in fresh processes; throws listing failures. */
export function runLeafChecks(leafIds) {
  const results = [];
  for (const id of leafIds) {
    for (const check of ledgerChecks(`leaf-${id}.md`)) {
      const res = sh('node', [join(root, 'scripts/verify/run.mjs'), check], { allowFail: true, timeout: 1_200_000 });
      const ok = res.status === 0 && new RegExp(`VERIFY ${check.replace(/\./g, '\\.')} PASS`).test(res.stdout);
      results.push({ check, ok, tail: (res.stdout + res.stderr).trim().split('\n').slice(-3).join(' | ') });
    }
  }
  const failed = results.filter((r) => !r.ok);
  assert(failed.length === 0, `child checks failed:\n${failed.map((f) => `${f.check}: ${f.tail}`).join('\n')}`);
  return `${results.length} child checks passed: ${results.map((r) => r.check).join(', ')}`;
}

/** Run named checks (used by regression gates). */
export function runChecks(names, { env } = {}) {
  const failed = [];
  for (const check of names) {
    const res = sh('node', [join(root, 'scripts/verify/run.mjs'), check], { allowFail: true, timeout: 1_200_000, env });
    if (!(res.status === 0 && res.stdout.includes(`VERIFY ${check} PASS`))) failed.push(`${check}: ${(res.stdout + res.stderr).trim().split('\n').slice(-3).join(' | ')}`);
  }
  assert(failed.length === 0, `regressions:\n${failed.join('\n')}`);
  return `${names.length} checks passed: ${names.join(', ')}`;
}

/** The packaged app, building it if missing or older than the sources (node scripts/release/package.mjs). */
export function ensurePackaged() {
  const app = join(desktop, 'release', 'mac-arm64', 'Director.app');
  const asar = join(app, 'Contents', 'Resources', 'app.asar');
  const srcNewest = Math.max(newestMtime(join(desktop, 'src')), ...['agent', 'engine', 'media', 'analysis', 'ai', 'library'].map((p) => newestMtime(join(root, 'packages', p, 'src'))), statSync(join(desktop, 'electron-builder.yml')).mtimeMs);
  if (!existsSync(asar) || statSync(asar).mtimeMs < srcNewest) sh('node', [join(root, 'scripts/release/package.mjs')], { timeout: 1_200_000 });
  assert(existsSync(asar), 'packaging produced no app');
  return app;
}

/** Read an asar archive's file list from its header (no dependency on the asar package). */
export function asarFiles(path) {
  const buf = readFileSync(path);
  const size = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + size).toString('utf8'));
  const out = [];
  const walk = (node, prefix) => { for (const [k, v] of Object.entries(node.files ?? {})) { const p = prefix ? `${prefix}/${k}` : k; if (v.files) walk(v, p); else out.push(p); } };
  walk(header, '');
  return out;
}
