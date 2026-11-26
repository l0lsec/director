import { AUDIO_LANES, clipEnd, type Clip, type Lane, type Project } from '@director/engine';

/** Speech intervals on the timeline: Voice-lane transcript words (merged across short gaps), else Voice clips. */
export function speechIntervals(doc: Project, mergeGapUs = 300_000): Array<{ from: number; to: number }> {
  const byMedia = new Map((doc.transcript ?? []).map((t) => [t.mediaId, t.words]));
  const raw: Array<{ from: number; to: number }> = [];
  for (const lane of doc.lanes.filter((l) => l.kind === 'voice' && !l.muted)) {
    for (const c of lane.clips) {
      if (!c.enabled || c.audio?.muted) continue;
      const words = c.mediaId ? byMedia.get(c.mediaId) : undefined;
      const rate = c.speed.kind === 'constant' ? c.speed.rate : 1;
      if (!words) { raw.push({ from: c.start, to: clipEnd(c) }); continue; }
      for (const w of words) {
        if (w.end <= c.in || w.start >= c.out) continue;
        raw.push({ from: c.start + (Math.max(w.start, c.in) - c.in) / rate, to: Math.min(clipEnd(c), c.start + (Math.min(w.end, c.out) - c.in) / rate) });
      }
    }
  }
  raw.sort((a, b) => a.from - b.from);
  const out: Array<{ from: number; to: number }> = [];
  for (const r of raw) {
    const last = out[out.length - 1];
    if (last && r.from - last.to <= mergeGapUs) last.to = Math.max(last.to, r.to); else out.push({ ...r });
  }
  return out;
}

export interface DuckOptions { depthDb: number; attackUs: number; releaseUs: number }
export const DEFAULT_DUCK: DuckOptions = { depthDb: -12, attackUs: 80_000, releaseUs: 300_000 };

/** Gain points (timeline time, linear gain) for a duckable clip, from speech intervals. */
export function duckingPoints(doc: Project, clip: Clip, lane: Lane, intervals = speechIntervals(doc)): Array<{ t: number; gain: number }> | null {
  if (!clip.audio?.duckable || !AUDIO_LANES.has(lane.kind) || lane.kind === 'voice') return null;
  const depth = typeof clip.meta?.duckDb === 'number' ? (clip.meta.duckDb as number) : DEFAULT_DUCK.depthDb;
  const g = Math.pow(10, depth / 20);
  // Speech that resumes before the music would have recovered stays ducked (no pumping).
  const merged: Array<{ from: number; to: number }> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv.from - last.to < DEFAULT_DUCK.releaseUs + DEFAULT_DUCK.attackUs) last.to = Math.max(last.to, iv.to); else merged.push({ ...iv });
  }
  const all: Array<{ t: number; gain: number }> = [];
  for (const iv of merged) {
    all.push({ t: Math.max(0, iv.from - 1000), gain: 1 });
    all.push({ t: iv.from + DEFAULT_DUCK.attackUs, gain: g });
    all.push({ t: iv.to, gain: g });
    all.push({ t: iv.to + DEFAULT_DUCK.releaseUs, gain: 1 });
  }
  // Envelope value at any time (linear between points), so a clip that starts mid-duck starts ducked.
  const at = (t: number) => {
    if (!all.length || t <= all[0]!.t) return 1;
    for (let i = 0; i < all.length - 1; i++) {
      const a = all[i]!, b = all[i + 1]!;
      if (t >= a.t && t <= b.t) return b.t === a.t ? b.gain : a.gain + ((b.gain - a.gain) * (t - a.t)) / (b.t - a.t);
    }
    return all[all.length - 1]!.gain;
  };
  const s0 = clip.start, s1 = clipEnd(clip);
  const pts = [{ t: s0, gain: at(s0) }, ...all.filter((p) => p.t > s0 && p.t < s1), { t: s1, gain: at(s1) }];
  return pts;
}
