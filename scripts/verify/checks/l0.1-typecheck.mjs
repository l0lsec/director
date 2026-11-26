import { sh, assert, root } from '../lib.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export default async function () {
  assert(existsSync(join(root, 'pnpm-lock.yaml')), 'pnpm-lock.yaml exists');
  sh('pnpm', ['install', '--frozen-lockfile', '--offline'], { allowFail: false });
  const res = sh('npx', ['tsc', '-p', 'tsconfig.json', '--noEmit'], { allowFail: true });
  assert(res.status === 0, `typecheck errors:\n${(res.stdout + res.stderr).slice(0, 3000)}`);
  const cfg = JSON.parse(sh('npx', ['tsc', '-p', 'tsconfig.json', '--showConfig']).stdout);
  assert(cfg.compilerOptions.strict === true, 'strict mode is on');
  assert(cfg.compilerOptions.noUncheckedIndexedAccess === true, 'noUncheckedIndexedAccess is on');
  return `typecheck clean over ${cfg.files?.length ?? '?'} files`;
}
