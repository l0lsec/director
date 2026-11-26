/** Shot detection from ffmpeg `scdet` scene scores with an adaptive threshold. */

export interface FrameScore { t: number; score: number }
export interface Shot { start: number; end: number }
export interface ShotOptions { minShotSec: number; minScore: number; k: number }
export const DEFAULT_SHOTS: ShotOptions = { minShotSec: 0.3, minScore: 6, k: 4 };

/**
 * Parse `metadata=print` output from `scdet=threshold=0`. Each frame prints a `pts_time:` line and a
 * `lavfi.scd.score=` line. Returns time (seconds) and score per frame, in order.
 */
export function parseScdet(text: string): FrameScore[] {
  const out: FrameScore[] = [];
  let t: number | null = null;
  for (const line of text.split('\n')) {
    const pt = /pts_time:([0-9.]+)/.exec(line);
    if (pt) { t = Number(pt[1]); continue; }
    const sc = /lavfi\.scd\.score=([0-9.]+)/.exec(line);
    if (sc && t != null) { out.push({ t, score: Number(sc[1]) }); t = null; }
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Cut times (seconds) from frame scores. A frame is a cut when its score is a local peak, clears an
 * absolute floor, and stands well above the local motion level (median + k * MAD over a 2 s window).
 * Peaks closer than `minShotSec` keep only the strongest, so flashes do not split a shot.
 */
export function detectCuts(scores: FrameScore[], opts: Partial<ShotOptions> = {}): number[] {
  const o = { ...DEFAULT_SHOTS, ...opts };
  if (scores.length < 3) return [];
  const dt = median(scores.slice(1).map((s, i) => s.t - scores[i]!.t)) || 1 / 30;
  const half = Math.max(3, Math.round(1 / dt));
  const candidates: FrameScore[] = [];
  for (let i = 1; i < scores.length; i++) {
    const s = scores[i]!;
    if (s.score < o.minScore) continue;
    if (s.score < (scores[i - 1]?.score ?? 0) || s.score < (scores[i + 1]?.score ?? 0)) continue;
    const win = scores.slice(Math.max(0, i - half), Math.min(scores.length, i + half + 1)).filter((_, j) => j !== i - Math.max(0, i - half)).map((x) => x.score);
    const med = median(win);
    const mad = median(win.map((x) => Math.abs(x - med)));
    if (s.score < med + o.k * Math.max(mad, 0.5) + 2) continue;
    candidates.push(s);
  }
  const kept: FrameScore[] = [];
  for (const c of candidates) {
    const last = kept[kept.length - 1];
    if (last && c.t - last.t < o.minShotSec) { if (c.score > last.score) kept[kept.length - 1] = c; continue; }
    kept.push(c);
  }
  return kept.map((c) => c.t);
}

export function shotsFromCuts(cuts: number[], duration: number): Shot[] {
  const pts = [0, ...cuts.filter((c) => c > 0 && c < duration), duration];
  const shots: Shot[] = [];
  for (let i = 0; i < pts.length - 1; i++) if (pts[i + 1]! > pts[i]!) shots.push({ start: pts[i]!, end: pts[i + 1]! });
  return shots;
}

/** Precision and recall of detected cut frames against truth, matching within `tolFrames`. */
export function scoreCuts(detected: number[], truth: number[], tolFrames = 1): { precision: number; recall: number; matched: Array<[number, number]>; maxError: number } {
  const used = new Set<number>();
  const matched: Array<[number, number]> = [];
  for (const d of detected) {
    let best = -1, bestErr = Infinity;
    truth.forEach((t, i) => { const e = Math.abs(t - d); if (!used.has(i) && e <= tolFrames && e < bestErr) { best = i; bestErr = e; } });
    if (best >= 0) { used.add(best); matched.push([d, truth[best]!]); }
  }
  return {
    precision: detected.length ? matched.length / detected.length : truth.length ? 0 : 1,
    recall: truth.length ? matched.length / truth.length : 1,
    matched,
    maxError: matched.reduce((m, [d, t]) => Math.max(m, Math.abs(d - t)), 0),
  };
}

/** ffmpeg arguments that print a scene score for every frame (downscaled: scores are scale-stable and this is fast). */
export function scdetArgs(input: string): string[] {
  return ['-hide_banner', '-nostats', '-v', 'error', '-i', input, '-map', '0:v:0', '-vf', 'scale=320:-2,scdet=threshold=0,metadata=print:file=-', '-an', '-f', 'null', '-'];
}
