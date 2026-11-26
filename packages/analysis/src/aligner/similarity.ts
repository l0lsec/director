/** Levenshtein distance with an early exit when it exceeds `max`. */
export function editDistance(a: string, b: string, max = 99): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Token similarity in [0, 1]. Tolerates recognizer slips like "prompts" vs "prompt" or "cloud" vs "claude". */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const longest = Math.max(a.length, b.length);
  if (longest <= 2) return 0;
  const d = editDistance(a, b, Math.ceil(longest / 2));
  const s = 1 - d / longest;
  return s >= 0.6 ? s : 0;
}
