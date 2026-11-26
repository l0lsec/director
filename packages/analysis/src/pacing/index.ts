import { clipEnd, timelineDuration, type Project } from '@director/engine';
import type { Shot } from '../shots';

/** Pacing numbers for a reference or for your own edit. All times in seconds. */
export interface Pacing {
  durationSec: number;
  shotCount: number;
  avgShotSec: number;
  medianShotSec: number;
  longestShotSec: number;
  cutsPerMin: number;
  firstCutSec: number | null;
  wordCount: number;
  wordsPerSec: number;
  wpm: number;
  /** Share of the runtime with speech (word time / duration). */
  speechRatio: number;
}

export interface PacingWord { start: number; end: number; text?: string }

export function computePacing(shots: Shot[], durationSec: number, words: PacingWord[]): Pacing {
  const lens = shots.map((s) => s.end - s.start).filter((l) => l > 0);
  const sorted = [...lens].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianShot = !sorted.length ? 0 : sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const cuts = Math.max(0, shots.length - 1);
  const speech = words.reduce((s, w) => s + Math.max(0, Math.min(w.end, durationSec) - Math.max(0, w.start)), 0);
  return {
    durationSec,
    shotCount: shots.length,
    avgShotSec: lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0,
    medianShotSec: medianShot,
    longestShotSec: sorted.length ? sorted[sorted.length - 1]! : 0,
    cutsPerMin: durationSec > 0 ? (cuts / durationSec) * 60 : 0,
    firstCutSec: shots.length > 1 ? shots[0]!.end : null,
    wordCount: words.length,
    wordsPerSec: durationSec > 0 ? words.length / durationSec : 0,
    wpm: durationSec > 0 ? (words.length / durationSec) * 60 : 0,
    speechRatio: durationSec > 0 ? speech / durationSec : 0,
  };
}

const VISUAL = new Set(['camera', 'screen', 'broll']);

/**
 * Shots of your own edit: every place the picture changes. That is a boundary between visual clips
 * (on camera, screen or b-roll lanes) or a punch-in zoom, deduplicated within one frame.
 */
export function editShots(doc: Project): Shot[] {
  const dur = timelineDuration(doc) / 1e6;
  const frame = doc.canvas.fps ? doc.canvas.fps.den / doc.canvas.fps.num : 1 / 30;
  const points: number[] = [];
  for (const lane of doc.lanes) {
    if (!VISUAL.has(lane.kind) || lane.hidden) continue;
    for (const c of lane.clips) {
      if (c.kind !== 'media' && c.kind !== 'placeholder') continue;
      points.push(c.start / 1e6, clipEnd(c) / 1e6);
      for (const e of c.effects) if (e.type === 'zoom' && e.enabled && typeof e.params.at === 'number') points.push((c.start + (e.params.at as number)) / 1e6);
    }
  }
  const cuts = [...new Set(points)].filter((t) => t > frame / 2 && t < dur - frame / 2).sort((a, b) => a - b);
  const dedup: number[] = [];
  for (const t of cuts) if (!dedup.length || t - dedup[dedup.length - 1]! > frame * 0.99) dedup.push(t);
  const pts = [0, ...dedup, dur];
  const shots: Shot[] = [];
  for (let i = 0; i < pts.length - 1; i++) shots.push({ start: pts[i]!, end: pts[i + 1]! });
  return dur > 0 ? shots : [];
}

export function editPacing(doc: Project, words: PacingWord[]): Pacing {
  return computePacing(editShots(doc), timelineDuration(doc) / 1e6, words);
}

export interface PacingDelta { metric: keyof Pacing; label: string; yours: number; reference: number; delta: number; pct: number | null; note: string | null }

const METRICS: Array<{ key: keyof Pacing; label: string; unit: string; better?: 'lower' | 'higher' }> = [
  { key: 'durationSec', label: 'Length', unit: 's' },
  { key: 'shotCount', label: 'Shots', unit: '' },
  { key: 'avgShotSec', label: 'Average shot', unit: 's' },
  { key: 'cutsPerMin', label: 'Cuts per minute', unit: '' },
  { key: 'firstCutSec', label: 'First cut', unit: 's' },
  { key: 'wordsPerSec', label: 'Words per second', unit: '' },
  { key: 'speechRatio', label: 'Speech coverage', unit: '' },
];

/** Your edit against a reference, metric by metric, with a plain-language note where the gap is large (over 15 percent). */
export function comparePacing(yours: Pacing, ref: Pacing): PacingDelta[] {
  const out: PacingDelta[] = [];
  for (const m of METRICS) {
    const y = yours[m.key] as number | null, r = ref[m.key] as number | null;
    if (y == null || r == null) continue;
    const delta = y - r;
    const pct = r !== 0 ? (delta / r) * 100 : null;
    let note: string | null = null;
    if (pct != null && Math.abs(pct) > 15) {
      const more = delta > 0;
      switch (m.key) {
        case 'avgShotSec': note = more ? `Your shots run ${Math.abs(pct).toFixed(0)}% longer; cut tighter to match.` : `Your shots are ${Math.abs(pct).toFixed(0)}% shorter than the reference.`; break;
        case 'cutsPerMin': note = more ? `You cut ${Math.abs(pct).toFixed(0)}% more often.` : `You cut ${Math.abs(pct).toFixed(0)}% less often; add punch-ins or b-roll.`; break;
        case 'firstCutSec': note = more ? `Your first cut comes ${Math.abs(delta).toFixed(1)} s later; hooks usually change picture sooner.` : `Your first cut comes ${Math.abs(delta).toFixed(1)} s sooner.`; break;
        case 'wordsPerSec': note = more ? `You talk ${Math.abs(pct).toFixed(0)}% faster.` : `You talk ${Math.abs(pct).toFixed(0)}% slower; trim pauses.`; break;
        case 'durationSec': note = more ? `Your edit is ${Math.abs(delta).toFixed(1)} s longer.` : `Your edit is ${Math.abs(delta).toFixed(1)} s shorter.`; break;
        default: note = null;
      }
    }
    out.push({ metric: m.key, label: m.label, yours: y, reference: r, delta, pct, note });
  }
  return out;
}
