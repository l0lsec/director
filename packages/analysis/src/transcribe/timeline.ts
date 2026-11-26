import { clipEnd, type LaneKind, type Project } from '@director/engine';

export interface TimelineWord { text: string; start: number; end: number; clipId: string; mediaId: string; srcStart: number; srcEnd: number; p?: number }

/**
 * Transcript words placed on the timeline through the clips that use them. Uses the first lane kind in
 * `order` that has transcribed clips (Voice, then Camera, ...), so linked camera/voice pairs are not doubled.
 * Clips whose sound is muted contribute no words (they are heard elsewhere, like speaker-layout shots over the
 * original clip), and the same spoken word placed twice at the same moment counts once.
 */
export function timelineWords(doc: Project, order: LaneKind[] = ['voice', 'camera', 'screen', 'broll']): TimelineWord[] {
  const byMedia = new Map((doc.transcript ?? []).map((t) => [t.mediaId, t.words]));
  for (const kind of order) {
    const out: TimelineWord[] = [];
    const seen = new Set<string>();
    for (const lane of doc.lanes.filter((l) => l.kind === kind)) {
      for (const c of lane.clips) {
        if (!c.mediaId || !c.enabled || c.reverse || c.speed.kind !== 'constant' || c.audio?.muted) continue;
        const words = byMedia.get(c.mediaId);
        if (!words) continue;
        const rate = c.speed.rate;
        const end = clipEnd(c);
        for (const w of words) {
          if (w.end <= c.in || w.start >= c.out) continue;
          const s = c.start + Math.round((Math.max(w.start, c.in) - c.in) / rate);
          const e = Math.min(end, c.start + Math.round((Math.min(w.end, c.out) - c.in) / rate));
          const key = `${c.mediaId}:${w.start}:${s}`;
          if (e > s && !seen.has(key)) { seen.add(key); out.push({ text: w.text, start: s, end: e, clipId: c.id, mediaId: c.mediaId, srcStart: w.start, srcEnd: w.end, p: w.p }); }
        }
      }
    }
    if (out.length) return out.sort((a, b) => a.start - b.start);
  }
  return [];
}
