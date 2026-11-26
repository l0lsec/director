import { z } from 'zod';
import type { ClaudeClient, CallRecord } from '../client/claude';

export const SEGMENT_LABELS = ['hook', 'setup', 'value', 'proof', 'payoff', 'cta', 'other'] as const;
export type SegmentLabel = (typeof SEGMENT_LABELS)[number];

/** What Claude returns. Kept simple (no numeric bounds) so it fits structured outputs; bounds are enforced by `normalizeSegments`. */
export const StructureSchema = z.object({
  hookType: z.string().describe('Short name for the hook technique, for example "bold claim", "question", "pattern interrupt"'),
  overall: z.string().describe('One or two sentences on why this reel works'),
  segments: z.array(z.object({
    label: z.enum(SEGMENT_LABELS),
    start: z.number().describe('Seconds from the start of the reel'),
    end: z.number().describe('Seconds from the start of the reel'),
    summary: z.string().describe('What happens in this part, in a few words'),
    technique: z.string().describe('The device used, for example "open loop", "list", "before and after", "social proof"'),
  })),
});
export type StructureOutput = z.infer<typeof StructureSchema>;
export interface Segment { label: SegmentLabel; start: number; end: number; summary: string; technique: string }
export interface Structure { hookType: string; overall: string; segments: Segment[]; durationSec: number }

export interface TimedWord { text: string; start: number; end: number }
export interface TimedShot { start: number; end: number }

/** Phrases split at pauses of 0.45 s or more (or every 14 words), each with its time range. */
export function phrases(words: TimedWord[], maxWords = 14, gap = 0.45): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  let cur: TimedWord[] = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text: cur.map((w) => w.text).join(' ') }); cur = []; };
  for (const w of words) {
    if (cur.length && (w.start - cur[cur.length - 1]!.end >= gap || cur.length >= maxWords)) flush();
    cur.push(w);
  }
  flush();
  return out;
}

const f = (s: number) => s.toFixed(2);

export function structurePrompt(words: TimedWord[], shots: TimedShot[], durationSec: number): string {
  const lines = phrases(words).map((p) => `[${f(p.start)}-${f(p.end)}] ${p.text}`);
  return [
    `Reel length: ${f(durationSec)} s. Shots: ${shots.length}.`,
    `Shot boundaries (s): ${shots.map((s) => f(s.start)).slice(1).join(', ') || 'none'}`,
    'Transcript with times (s):',
    lines.join('\n') || '(no speech)',
    '',
    `Label the structure. Segments must be in time order and together cover 0 to ${f(durationSec)} s with no gaps or overlaps. Prefer boundaries at phrase or shot boundaries.`,
  ].join('\n');
}

export const STRUCTURE_SYSTEM = `You analyze short-form vertical videos (Reels, TikToks, Shorts) for a creator who studies what works.
You receive a timed transcript and shot boundaries, never the video itself.
Break the reel into its structural parts using these labels:
- hook: the opening that stops the scroll
- setup: context or the problem
- value: the main teaching, list items or story beats
- proof: results, numbers, testimonials, demonstrations
- payoff: the resolution or the twist that pays off the hook
- cta: the call to action (follow, comment, link)
- other: anything that fits none of these
Be specific and brief. Times are in seconds.`;

/**
 * Make segments exactly tile [0, duration]: sort, clamp, snap the first start to 0 and the last end
 * to the duration, meet neighbours at the midpoint of any gap or overlap, snap boundaries to a shot
 * boundary within 0.25 s, and drop empty segments.
 */
export function normalizeSegments(raw: StructureOutput['segments'], durationSec: number, shots: TimedShot[] = []): Segment[] {
  const D = durationSec;
  let segs = raw
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({ ...s, start: Math.max(0, Math.min(D, s.start)), end: Math.max(0, Math.min(D, s.end)), summary: s.summary.trim().slice(0, 300), technique: s.technique.trim().slice(0, 120) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  if (!segs.length) return [{ label: 'other', start: 0, end: D, summary: '', technique: '' }];
  // Drop segments fully inside an earlier one.
  segs = segs.filter((s, i) => !segs.slice(0, i).some((p) => p.start <= s.start && p.end >= s.end));
  const cutPoints = shots.map((s) => s.start).filter((t) => t > 0 && t < D);
  const snap = (t: number) => {
    let best = t, err = 0.25;
    for (const c of cutPoints) if (Math.abs(c - t) <= err) { best = c; err = Math.abs(c - t); }
    return best;
  };
  segs[0]!.start = 0;
  segs[segs.length - 1]!.end = D;
  for (let i = 0; i < segs.length - 1; i++) {
    const a = segs[i]!, b = segs[i + 1]!;
    const meet = snap((a.end + b.start) / 2);
    a.end = meet;
    b.start = meet;
  }
  const out = segs.filter((s) => s.end - s.start > 1e-6);
  // Dropping an empty segment can leave a hole; close it by extending the previous one.
  for (let i = 1; i < out.length; i++) out[i]!.start = out[i - 1]!.end;
  out[0]!.start = 0;
  out[out.length - 1]!.end = D;
  return out;
}

/** Check that segments tile [0, duration] exactly. Returns problems, empty when valid. */
export function tilingProblems(segs: Segment[], durationSec: number, eps = 1e-9): string[] {
  const p: string[] = [];
  if (!segs.length) return ['no segments'];
  if (Math.abs(segs[0]!.start) > eps) p.push(`first segment starts at ${segs[0]!.start}`);
  if (Math.abs(segs[segs.length - 1]!.end - durationSec) > eps) p.push(`last segment ends at ${segs[segs.length - 1]!.end}, not ${durationSec}`);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    if (!(s.end > s.start)) p.push(`segment ${i} is empty`);
    if (!SEGMENT_LABELS.includes(s.label)) p.push(`segment ${i} has label ${s.label}`);
    if (i && Math.abs(s.start - segs[i - 1]!.end) > eps) p.push(`${s.start > segs[i - 1]!.end ? 'gap' : 'overlap'} between segments ${i - 1} and ${i}`);
  }
  return p;
}

export async function labelStructure(client: ClaudeClient, input: { words: TimedWord[]; shots: TimedShot[]; durationSec: number }): Promise<{ structure: Structure; record: CallRecord }> {
  const { data, record } = await client.call({
    task: 'structure',
    system: STRUCTURE_SYSTEM,
    prompt: structurePrompt(input.words, input.shots, input.durationSec),
    schema: StructureSchema,
    effort: 'medium',
    maxTokens: 8000,
  });
  return {
    structure: { hookType: data.hookType.trim().slice(0, 80), overall: data.overall.trim().slice(0, 600), segments: normalizeSegments(data.segments, input.durationSec, input.shots), durationSec: input.durationSec },
    record,
  };
}
