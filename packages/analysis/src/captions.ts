import { newClip, laneOfKind, clipEnd, uid, type Clip, type Op, type Project, type TextSpec } from '@director/engine';
import type { TimelineWord } from './transcribe/timeline';

export interface CaptionStyle { id: string; label: string; text: Omit<TextSpec, 'content' | 'words'>; position: number }

/** Built-in caption looks. position = vertical center as a fraction of canvas height. */
export const CAPTION_STYLES: CaptionStyle[] = [
  { id: 'word-pop', label: 'Word pop', position: 0.64, text: { styleId: 'word-pop', font: 'Inter', size: 86, weight: 900, color: '#ffffff', highlightColor: '#f5e23d', align: 'center', lineHeight: 1.05, maxWidth: 0.84, stroke: { color: '#000000', width: 9 }, uppercase: true, animationIn: 'pop', animationDuration: 120_000 } },
  { id: 'karaoke', label: 'Karaoke', position: 0.66, text: { styleId: 'karaoke', font: 'Inter', size: 78, weight: 800, color: '#ffffff', highlightColor: '#5fd1ff', align: 'center', lineHeight: 1.1, maxWidth: 0.86, stroke: { color: '#000000', width: 7 } } },
  { id: 'boxed', label: 'Boxed', position: 0.68, text: { styleId: 'boxed', font: 'Inter', size: 64, weight: 700, color: '#ffffff', highlightColor: '#ffd166', align: 'center', lineHeight: 1.15, maxWidth: 0.82, box: { color: 'rgba(0,0,0,0.72)', padding: 18, radius: 14 } } },
  { id: 'clean', label: 'Clean', position: 0.7, text: { styleId: 'clean', font: 'Inter', size: 62, weight: 600, color: '#ffffff', align: 'center', lineHeight: 1.2, maxWidth: 0.86, shadow: { color: 'rgba(0,0,0,0.85)', blur: 12, x: 0, y: 3 } } },
  { id: 'bold-yellow', label: 'Bold yellow', position: 0.6, text: { styleId: 'word-pop', font: 'Inter', size: 96, weight: 900, color: '#f5e23d', highlightColor: '#ffffff', align: 'center', lineHeight: 1.0, maxWidth: 0.8, stroke: { color: '#000000', width: 10 }, uppercase: true, animationIn: 'pop', animationDuration: 120_000 } },
];

export interface CaptionOptions { maxWords: number; maxChars: number; breakOnPause: number; styleId: string; position?: number }
export const DEFAULT_CAPTIONS: CaptionOptions = { maxWords: 4, maxChars: 24, breakOnPause: 300_000, styleId: 'word-pop' };

/** Safe areas (fraction of height/width kept clear) for vertical platforms' overlays. */
export const SAFE_ZONES: Record<string, { top: number; bottom: number; left: number; right: number }> = {
  reels: { top: 0.12, bottom: 0.2, left: 0.04, right: 0.15 },
  tiktok: { top: 0.1, bottom: 0.22, left: 0.04, right: 0.16 },
  shorts: { top: 0.1, bottom: 0.18, left: 0.04, right: 0.14 },
};

/**
 * Group words into caption cards: at most maxWords/maxChars, break at pauses, and never across a cut
 * (cards stay inside the clip their words come from).
 */
export function chunkCaptions(words: TimelineWord[], o: CaptionOptions = DEFAULT_CAPTIONS): TimelineWord[][] {
  const cards: TimelineWord[][] = [];
  let cur: TimelineWord[] = [];
  const len = (ws: TimelineWord[]) => ws.reduce((n, w) => n + w.text.length, 0) + Math.max(0, ws.length - 1);
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const breakHere = prev && (cur.length >= o.maxWords || len([...cur, w]) > o.maxChars || w.start - prev.end > o.breakOnPause || w.clipId !== prev.clipId || /[.!?]$/.test(prev.text));
    if (breakHere) { cards.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) cards.push(cur);
  return cards;
}

/** Where a caption block sits: centered inside the platform safe zone, no wider than it. */
export function captionLayout(style: CaptionStyle, zone: string, W: number, H: number, position?: number): { cx: number; cy: number; maxWidth: number } {
  const z = SAFE_ZONES[zone] ?? { top: 0, bottom: 0, left: 0.04, right: 0.04 };
  const chrome = (2 * ((style.text.box?.padding ?? 0) + (style.text.stroke?.width ?? 0))) / W;
  const maxWidth = Math.min(style.text.maxWidth, 1 - z.left - z.right - 0.03 - chrome);
  return { cx: ((z.left + 1 - z.right) / 2) * W, cy: (position ?? style.position) * H, maxWidth };
}

/** Caption clips (with word timing for highlighting) on the Captions lane, replacing existing captions. */
export function captionOps(doc: Project, words: TimelineWord[], o: CaptionOptions = DEFAULT_CAPTIONS): Op[] {
  const lane = laneOfKind(doc, 'captions');
  if (!lane) return [];
  const style = CAPTION_STYLES.find((s) => s.id === o.styleId) ?? CAPTION_STYLES[0]!;
  const ops: Op[] = lane.clips.filter((c) => c.kind === 'caption').map((c) => ({ op: 'removeClip' as const, id: c.id }));
  const H = doc.canvas.height;
  const W = doc.canvas.width;
  const layout = captionLayout(style, H > W ? doc.settings.safeZone : 'none', W, H, o.position);
  const cards = chunkCaptions(words, o);
  cards.forEach((card, i) => {
    const start = card[0]!.start;
    const next = cards[i + 1]?.[0];
    // Hold each card until the next one (or briefly past its last word), but stay inside the source clip.
    const sameClipNext = next && next.clipId === card[0]!.clipId ? next.start : Infinity;
    const end = Math.min(sameClipNext, card[card.length - 1]!.end + 250_000, clipEndOf(doc, card[0]!.clipId));
    const clip: Clip = newClip({
      id: uid('cap'), kind: 'caption', start, in: 0, out: Math.max(end - start, 60_000), name: card.map((w) => w.text).join(' '),
      text: { ...style.text, maxWidth: layout.maxWidth, content: card.map((w) => w.text).join(' '), words: card.map((w) => ({ text: w.text, start: w.start - start, end: w.end - start })) },
    });
    clip.transform = { ...clip.transform, x: { value: Math.round(layout.cx - W / 2) }, y: { value: Math.round(layout.cy - H / 2) } };
    ops.push({ op: 'addClip', laneId: lane.id, clip });
  });
  return ops;
}

function clipEndOf(doc: Project, clipId: string): number {
  for (const l of doc.lanes) for (const c of l.clips) if (c.id === clipId) return clipEnd(c);
  return Infinity;
}

/** SRT and WebVTT for the caption clips on a timeline. */
export function captionsToSubtitles(doc: Project, format: 'srt' | 'vtt'): string {
  const lane = laneOfKind(doc, 'captions');
  const clips = (lane?.clips ?? []).filter((c) => c.text).sort((a, b) => a.start - b.start);
  const ts = (us: number) => {
    const ms = Math.round(us / 1000);
    const h = Math.floor(ms / 3_600_000), m = Math.floor(ms / 60_000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
    const p = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${p(h)}:${p(m)}:${p(s)}${format === 'srt' ? ',' : '.'}${p(r, 3)}`;
  };
  const cues = clips.map((c, i) => `${format === 'srt' ? `${i + 1}\n` : ''}${ts(c.start)} --> ${ts(clipEnd(c))}\n${c.text!.content}\n`);
  return format === 'vtt' ? `WEBVTT\n\n${cues.join('\n')}` : cues.join('\n');
}
