import { tokenSimilarity } from './aligner/similarity';

export interface AlignPair { a: number | null; b: number | null; sim: number }

/**
 * Global alignment of two word sequences (Needleman-Wunsch with fuzzy token similarity).
 * Returns pairs in order; a or b is null for insertions/deletions.
 */
export function alignSequences(a: string[], b: string[], gap = -0.6): AlignPair[] {
  const n = a.length, m = b.length;
  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const move = new Uint8Array((n + 1) * W); // 0 diag, 1 up (a gap), 2 left (b gap)
  for (let i = 1; i <= n; i++) { score[i * W] = i * gap; move[i * W] = 1; }
  for (let j = 1; j <= m; j++) { score[j] = j * gap; move[j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = tokenSimilarity(a[i - 1]!, b[j - 1]!);
      const diag = score[(i - 1) * W + j - 1]! + (s > 0 ? s : -0.8);
      const up = score[(i - 1) * W + j]! + gap;
      const left = score[i * W + j - 1]! + gap;
      if (diag >= up && diag >= left) { score[i * W + j] = diag; move[i * W + j] = 0; }
      else if (up >= left) { score[i * W + j] = up; move[i * W + j] = 1; }
      else { score[i * W + j] = left; move[i * W + j] = 2; }
    }
  }
  const out: AlignPair[] = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const mv = i > 0 && j > 0 ? move[i * W + j] : i > 0 ? 1 : 2;
    if (mv === 0) { out.push({ a: i - 1, b: j - 1, sim: tokenSimilarity(a[i - 1]!, b[j - 1]!) }); i--; j--; }
    else if (mv === 1) { out.push({ a: i - 1, b: null, sim: 0 }); i--; }
    else { out.push({ a: null, b: j - 1, sim: 0 }); j--; }
  }
  return out.reverse();
}
