// Repo hygiene scanner shared by l0.1-hygiene and root-hygiene.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from './lib.mjs';

export const EM_DASH = String.fromCharCode(0x2014);
export const PLACEHOLDER = /\bTBD\b|\bTODO\b|\bFIXME\b|\bXXX\b|lorem ipsum/i;
const TEXT = /\.(ts|tsx|mjs|js|cjs|json|md|css|html|swift|yml|yaml|txt)$/;

export function trackedFiles(root) {
  const out = sh('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root }).stdout.split('\n').filter(Boolean);
  return out.filter((f) => TEXT.test(f) && !f.startsWith('fixtures/media/') && !f.endsWith('pnpm-lock.yaml') && existsSync(join(root, f)));
}

export function scanText(text) {
  const issues = [];
  if (text.includes(EM_DASH)) issues.push('em dash');
  if (PLACEHOLDER.test(text)) issues.push(`placeholder marker "${text.match(PLACEHOLDER)[0]}"`);
  return issues;
}

export function scanRepo(root, { skipPlaceholderIn = [] } = {}) {
  const problems = [];
  const files = trackedFiles(root);
  for (const f of files) {
    const text = readFileSync(join(root, f), 'utf8');
    let issues = scanText(text);
    if (skipPlaceholderIn.some((p) => f.startsWith(p))) issues = issues.filter((i) => i === 'em dash');
    for (const i of issues) problems.push(`${f}: ${i}`);
  }
  return { files: files.length, problems };
}
