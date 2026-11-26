import { assert, root } from '../lib.mjs';
import { scanRepo, scanText, EM_DASH } from '../hygiene.mjs';

export default async function () {
  // Positive controls: the scanner must flag planted problems.
  assert(scanText(`a ${EM_DASH} b`).includes('em dash'), 'em dash control');
  assert(scanText('fix later: TODO').length === 1, 'placeholder control');
  assert(scanText('clean text, with commas: fine').length === 0, 'clean control');
  const { files, problems } = scanRepo(root, { skipPlaceholderIn: ['scripts/verify/hygiene.mjs', 'scripts/verify/checks/l0.1-hygiene.mjs'] });
  assert(files > 30, `scanned only ${files} files`);
  assert(problems.length === 0, `hygiene problems:\n${problems.join('\n')}`);
  return `scanned ${files} files`;
}
