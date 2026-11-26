#!/usr/bin/env node
// Gate check dispatcher: `node scripts/verify/run.mjs <check>` loads scripts/verify/checks/<check>.mjs,
// runs its default export, and prints "VERIFY <check> PASS" only if it resolves without throwing.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const name = process.argv[2];
if (!name || !/^[a-z0-9.\-]+$/i.test(name)) {
  console.error('usage: run.mjs <check-name>');
  process.exit(2);
}
const file = join(here, 'checks', `${name}.mjs`);
if (!existsSync(file)) {
  console.error(`VERIFY ${name} FAIL: no check module at ${file}`);
  process.exit(1);
}
const started = Date.now();
try {
  const mod = await import(pathToFileURL(file).href);
  const detail = await mod.default({ args: process.argv.slice(3) });
  if (detail) console.log(typeof detail === 'string' ? detail : JSON.stringify(detail));
  console.log(`VERIFY ${name} PASS (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  process.exit(0);
} catch (err) {
  console.error(`VERIFY ${name} FAIL: ${err?.stack ?? err}`);
  process.exit(1);
}
