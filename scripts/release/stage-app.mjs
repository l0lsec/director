#!/usr/bin/env node
// Build the app with every dependency bundled, then stage apps/desktop/build/app for electron-builder.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktop = join(root, 'apps', 'desktop');
execFileSync('npx', ['electron-vite', 'build'], { cwd: desktop, stdio: 'inherit', env: { ...process.env, DIRECTOR_BUNDLE_ALL: '1' } });
// Fail fast if anything still expects node_modules at runtime: real import statements only (not comments,
// and not ajv's code-generation templates, which only run in its standalone mode).
const BUILTIN = /^(node:.+|electron|(fs|path|os|crypto|child_process|http|https|http2|net|url|util|events|stream|zlib|module|worker_threads|buffer|assert|tty|readline|string_decoder|querystring|dns|timers|perf_hooks|async_hooks|v8|vm|process|constants)(\/.*)?)$/;
const files = ['out/main/index.js', ...readdirSync(join(desktop, 'out', 'main', 'chunks')).map((f) => `out/main/chunks/${f}`), 'out/preload/index.cjs'];
const bare = new Set();
for (const f of files) {
  const src = readFileSync(join(desktop, f), 'utf8');
  for (const re of [/^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm, /^\s*import\s*["']([^"']+)["']/gm, /\bimport\(\s*["']([^"']+)["']\s*\)/g, /(?<!`)\brequire\(\s*["']([^"']+)["']\s*\)/g]) {
    for (const m of src.matchAll(re)) if (!m[1].startsWith('.') && !BUILTIN.test(m[1])) bare.add(`${m[1]} (${f})`);
  }
}
if (bare.size) { console.error(`STAGE FAIL: the build still imports packages at runtime: ${[...bare].join(', ')}`); process.exit(1); }
const app = join(desktop, 'build', 'app');
rmSync(app, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
cpSync(join(desktop, 'out'), join(app, 'out'), { recursive: true });
const pkg = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'director', productName: 'Director', version: pkg.version, description: pkg.description, main: 'out/main/index.js', type: pkg.type, author: 'Director' }, null, 2));
if (!existsSync(join(desktop, 'build', 'sidecars', 'manifest.json'))) { console.error('STAGE FAIL: run scripts/release/bundle-sidecars.mjs first'); process.exit(1); }
console.log(`staged ${app}`);
