import { clipEnd, normalizeWord, rippleDeleteRangesOps, mergeRanges, timelineDuration, applyOps, type Op, type Project } from '@director/engine';
import type { TimelineWord } from '../transcribe/timeline';

export type CutReason = 'pause' | 'filler' | 'retake' | 'lead' | 'tail' | 'words';
export interface CutRange { from: number; to: number; reason: CutReason; label: string }

export const DEFAULT_FILLERS = ['um', 'uh', 'uhm', 'umm', 'erm', 'er', 'ah', 'hmm', 'mm', 'mhm'];

export interface AutoCutOptions {
  /** Pauses longer than this are shortened (microseconds). */
  minPause: number;
  /** Silence kept on each side of a cut so speech is not clipped. */
  keep: number;
  fillers: string[] | false;
  trimEnds: boolean;
}
export const DEFAULT_AUTOCUT: AutoCutOptions = { minPause: 350_000, keep: 80_000, fillers: DEFAULT_FILLERS, trimEnds: true };

export function findPauses(words: TimelineWord[], end: number, o: AutoCutOptions): CutRange[] {
  const out: CutRange[] = [];
  if (!words.length) return out;
  if (o.trimEnds && words[0]!.start - o.keep > 0) out.push({ from: 0, to: words[0]!.start - o.keep, reason: 'lead', label: 'Silence before the first word' });
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1]!.start - words[i]!.end;
    if (gap > o.minPause) out.push({ from: words[i]!.end + o.keep, to: words[i + 1]!.start - o.keep, reason: 'pause', label: `Pause ${(gap / 1e6).toFixed(2)} s after "${words[i]!.text}"` });
  }
  const last = words[words.length - 1]!;
  if (o.trimEnds && end - (last.end + o.keep) > 20_000) out.push({ from: last.end + o.keep, to: end, reason: 'tail', label: 'Silence after the last word' });
  return out.filter((r) => r.to - r.from > 20_000);
}

export function findFillers(words: TimelineWord[], fillers: string[], keep = 30_000): CutRange[] {
  const set = new Set(fillers.map((f) => normalizeWord(f)));
  const out: CutRange[] = [];
  words.forEach((w, i) => {
    if (!set.has(normalizeWord(w.text))) return;
    const prevEnd = i > 0 ? words[i - 1]!.end : 0;
    const nextStart = i < words.length - 1 ? words[i + 1]!.start : w.end + keep;
    // Take the filler and the breath around it, but never touch neighbouring words.
    out.push({ from: Math.max(prevEnd + keep, w.start - keep), to: Math.min(nextStart - keep, w.end + keep), reason: 'filler', label: `Filler "${w.text}"` });
  });
  return out.filter((r) => r.to > r.from);
}

/** Ranges for deleting the given words (indices into `words`), cut cleanly at word boundaries. */
export function rangesForWords(words: TimelineWord[], indices: number[]): CutRange[] {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const out: CutRange[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    const a = words[sorted[i]!]!, b = words[sorted[j]!]!;
    const next = words[sorted[j]! + 1];
    // Remove from the first word's start up to the next kept word, keeping the rhythm of what remains.
    out.push({ from: a.start, to: next ? Math.min(next.start, b.end + Math.max(0, next.start - b.end)) : b.end, reason: 'words', label: words.slice(sorted[i]!, sorted[j]! + 1).map((w) => w.text).join(' ') });
    i = j + 1;
  }
  return out;
}

export function planAutoCut(doc: Project, words: TimelineWord[], o: AutoCutOptions = DEFAULT_AUTOCUT, extra: CutRange[] = []): CutRange[] {
  const ranges = [...findPauses(words, timelineDuration(doc), o), ...(o.fillers ? findFillers(words, o.fillers) : []), ...extra];
  return ranges.sort((a, b) => a.from - b.from);
}

/** Total time removed by a set of (possibly overlapping) ranges. */
export function removedDuration(ranges: CutRange[]): number {
  return mergeRanges(ranges).reduce((n, r) => n + (r.to - r.from), 0);
}

/**
 * Ripple-delete the ranges on every lane, then give each audio clip that now begins or ends at a cut
 * a short fade so the joins do not click.
 */
export function cutOps(doc: Project, ranges: CutRange[], crossfadeUs = 10_000): Op[] {
  const merged = mergeRanges(ranges);
  if (!merged.length) return [];
  const ops = rippleDeleteRangesOps(doc, merged);
  const after = applyOps(doc, ops).doc;
  // Cut points in the new timeline: each range collapses to (from - time removed before it).
  const points: number[] = [];
  let removed = 0;
  for (const r of merged) { points.push(r.from - removed); removed += r.to - r.from; }
  const near = (t: number) => points.some((p) => Math.abs(p - t) <= 1_000);
  const fades: Op[] = [];
  for (const lane of after.lanes) for (const c of lane.clips) {
    if (!c.audio) continue;
    const fi = near(c.start) && c.audio.fadeIn < crossfadeUs;
    const fo = near(clipEnd(c)) && c.audio.fadeOut < crossfadeUs;
    if (fi || fo) fades.push({ op: 'updateClip', id: c.id, patch: { audio: { ...c.audio, fadeIn: fi ? crossfadeUs : c.audio.fadeIn, fadeOut: fo ? crossfadeUs : c.audio.fadeOut } } });
  }
  return [...ops, ...fades];
}
