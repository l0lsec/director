import { z } from 'zod';
import {
  applyOps, clipEnd, defaultText, findClip, laneOfKind, mergeRanges, newClip, timelineDuration, uid,
  type Op, type Project,
} from '@director/engine';
import { cutOps, timelineWords, type TimelineWord } from '@director/analysis';
import type { ClaudeClient, CallRecord } from '../client/claude';
import { phrases } from '../structure';
import type { Pacing } from '@director/analysis';

export const ACTION_TYPES = ['cut', 'zoom', 'broll', 'text', 'marker'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * What Claude returns: a flat action list (one shape for every type keeps structured outputs simple).
 * Times are seconds on the current timeline. Unused fields are 0 or empty.
 */
export const DirectorSchema = z.object({
  summary: z.string().describe('One or two sentences: what this pass changes and why'),
  actions: z.array(z.object({
    type: z.enum(ACTION_TYPES).describe('cut removes start..end (ripple); zoom punches in from start to end; broll marks start..end for b-roll; text adds an on-screen title; marker drops a note at start'),
    start: z.number().describe('Seconds on the current timeline'),
    end: z.number().describe('Seconds on the current timeline; equal to start for a marker'),
    text: z.string().describe('Title text, b-roll description or marker note; empty for cut and zoom'),
    amount: z.number().describe('Zoom scale, 1.05 to 1.6; 0 for other types'),
    reason: z.string().describe('Why, in one short sentence'),
  })),
});
export type DirectorOutput = z.infer<typeof DirectorSchema>;
export type DirectorAction = DirectorOutput['actions'][number];

export const DIRECTOR_SYSTEM = `You are an experienced short-form video editor acting as the creator's director.
You see the timed transcript, a summary of the timeline (lanes and clips, no media), optional reference pacing and the creator's goal.
Propose a focused list of concrete edits using only these actions:
- cut: remove start..end from every lane (ripple). Use for dead air, stumbles, repeated takes, slow setup. Never cut inside a word.
- zoom: punch in from start to end on the camera, amount 1.05 to 1.6. Use on key points, at most one every few seconds.
- broll: mark start..end where b-roll should cover the speaker, with a description of what to show.
- text: an on-screen title from start to end, under 8 words.
- marker: a note for the creator at start.
All times are seconds on the current timeline, before any of your cuts. Every action needs a reason. Do not cut more than half the runtime.`;

const f = (us: number) => (us / 1e6).toFixed(2);
const looksLikeFile = (s: string) => /\.[a-z0-9]{2,4}$/i.test(s) || /[/\\]/.test(s);

/** Timeline summary as text: lanes, clips, effects and markers. Never file names or paths. */
export function timelineSummary(doc: Project): string {
  const lines = [`Canvas ${doc.canvas.width}x${doc.canvas.height}, duration ${f(timelineDuration(doc))} s.`];
  for (const lane of doc.lanes) {
    if (!lane.clips.length) continue;
    lines.push(`Lane ${lane.kind}${lane.muted ? ' (muted)' : ''}${lane.hidden ? ' (hidden)' : ''}: ${lane.clips.length} clip(s)`);
    for (const c of lane.clips.slice(0, 60)) {
      const name = c.kind === 'text' || c.kind === 'caption' ? (c.text?.content ?? '').slice(0, 40) : c.name && !looksLikeFile(c.name) ? c.name.slice(0, 40) : '';
      const fx = c.effects.filter((e) => e.enabled).map((e) => e.type);
      lines.push(`  - ${c.kind} ${f(c.start)}-${f(clipEnd(c))} s${name ? ` "${name.replace(/\s+/g, ' ')}"` : ''}${fx.length ? ` effects: ${fx.join(', ')}` : ''}`);
    }
    if (lane.clips.length > 60) lines.push(`  (${lane.clips.length - 60} more)`);
  }
  const marks = doc.markers.filter((m) => m.kind === 'cue' || m.kind === 'note' || m.kind === 'retake');
  if (marks.length) lines.push(`Markers: ${marks.slice(0, 80).map((m) => `${m.kind} ${f(m.t)} s "${m.label.slice(0, 40)}"`).join('; ')}`);
  return lines.join('\n');
}

export function directorPrompt(doc: Project, words: TimelineWord[], opts: { goal: string; reference?: Pacing | null; targetSec?: number | null }): string {
  const ph = phrases(words.map((w) => ({ text: w.text, start: w.start / 1e6, end: w.end / 1e6 })));
  const ref = opts.reference
    ? `Reference pacing: ${opts.reference.durationSec.toFixed(1)} s, ${opts.reference.shotCount} shots, average shot ${opts.reference.avgShotSec.toFixed(2)} s, ${opts.reference.cutsPerMin.toFixed(1)} cuts per minute, first cut at ${opts.reference.firstCutSec?.toFixed(2) ?? 'none'} s, ${opts.reference.wordsPerSec.toFixed(2)} words per second.`
    : '';
  return [
    timelineSummary(doc),
    '',
    'Transcript on the timeline (s):',
    ph.map((p) => `[${p.start.toFixed(2)}-${p.end.toFixed(2)}] ${p.text}`).join('\n') || '(no speech)',
    '',
    ref,
    opts.targetSec ? `Target length: ${opts.targetSec} s.` : '',
    `Goal: ${opts.goal.trim() || 'Tighten the pacing and add emphasis where it helps.'}`,
  ].filter((l) => l !== '').join('\n');
}

export interface ActionProblem { index: number; reason: string }
export interface PreviewItem { index: number; type: ActionType; label: string; reason: string; startUs: number; endUs: number }
export interface DirectorPlan {
  ok: boolean;
  ops: Op[];
  problems: ActionProblem[];
  preview: PreviewItem[];
  before: number;
  after: number;
  removedUs: number;
  counts: Record<ActionType, number>;
}

const MAX_ACTIONS = 200;
const MAX_CUT_SHARE = 0.5;

/** Map a time on the original timeline through ripple cuts. Times inside a cut collapse to its start. */
export function mapThroughCuts(t: number, merged: Array<{ from: number; to: number }>): number {
  let removed = 0;
  for (const r of merged) {
    if (t >= r.to) removed += r.to - r.from;
    else if (t > r.from) return r.from - removed;
    else break;
  }
  return t - removed;
}

/**
 * Validate actions against the project and compile them to primitive ops, all or nothing.
 * Any invalid action makes the whole plan invalid (with one reason per problem) and returns no ops.
 * `enabled` limits compilation to the actions the user kept.
 */
export function compileDirector(doc: Project, actions: DirectorAction[], enabled?: Set<number>): DirectorPlan {
  const D = timelineDuration(doc);
  const problems: ActionProblem[] = [];
  const counts = Object.fromEntries(ACTION_TYPES.map((t) => [t, 0])) as Record<ActionType, number>;
  const empty = (): DirectorPlan => ({ ok: false, ops: [], problems, preview: [], before: D, after: D, removedUs: 0, counts });
  if (actions.length > MAX_ACTIONS) { problems.push({ index: -1, reason: `${actions.length} actions is more than the ${MAX_ACTIONS} allowed` }); return empty(); }
  const chosen = actions.map((a, index) => ({ a, index })).filter(({ index }) => !enabled || enabled.has(index));
  const words = timelineWords(doc);
  const eps = 1_000;
  const visualAt = (t: number) => {
    for (const kind of ['camera', 'screen'] as const) {
      const lane = laneOfKind(doc, kind);
      const c = lane?.clips.find((x) => x.kind === 'media' && x.start <= t && clipEnd(x) > t);
      if (c) return c;
    }
    return null;
  };
  for (const { a, index } of chosen) {
    const bad = (reason: string) => problems.push({ index, reason: `${a.type} ${a.start}-${a.end} s: ${reason}` });
    if (!a.reason?.trim()) bad('missing a reason');
    if (!Number.isFinite(a.start) || !Number.isFinite(a.end)) { bad('times are not numbers'); continue; }
    const s = Math.round(a.start * 1e6), e = Math.round(a.end * 1e6);
    if (s < 0 || s > D + eps) { bad(`start is outside the timeline (0 to ${f(D)} s)`); continue; }
    if (a.type === 'marker') continue;
    if (e > D + eps) { bad(`end is past the end of the timeline (${f(D)} s)`); continue; }
    if (e - s < 50_000) { bad('range is shorter than 0.05 s or reversed'); continue; }
    if (a.type === 'cut') {
      const inside = words.find((w) => (s > w.start + 20_000 && s < w.end - 20_000) || (e > w.start + 20_000 && e < w.end - 20_000));
      if (inside) bad(`would cut through the word "${inside.text}"`);
    }
    if (a.type === 'zoom') {
      if (!(a.amount >= 1.05 && a.amount <= 1.6)) bad(`zoom amount ${a.amount} is outside 1.05 to 1.6`);
      const c = visualAt(s);
      if (!c) bad('no camera or screen clip to zoom at that time');
      else if (e > clipEnd(c) + eps) bad('zoom runs past the end of its clip');
    }
    if (a.type === 'text' || a.type === 'broll') {
      if (!a.text?.trim()) bad('needs text');
      else if (a.type === 'text' && a.text.trim().length > 120) bad('title is longer than 120 characters');
    }
  }
  const cuts = chosen.filter(({ a }) => a.type === 'cut').map(({ a }) => ({ from: Math.max(0, Math.round(a.start * 1e6)), to: Math.min(D, Math.round(a.end * 1e6)) }));
  const merged = mergeRanges(cuts);
  const removed = merged.reduce((n, r) => n + (r.to - r.from), 0);
  if (D > 0 && removed / D > MAX_CUT_SHARE) problems.push({ index: -1, reason: `cuts remove ${((removed / D) * 100).toFixed(0)}% of the runtime (more than ${MAX_CUT_SHARE * 100}% allowed)` });
  // B-roll ranges must not overlap existing b-roll or each other (after mapping).
  if (problems.length) return empty();

  let cur = doc;
  const ops: Op[] = [];
  const tx = (more: Op[]) => { if (!more.length) return; cur = applyOps(cur, more).doc; ops.push(...more); };
  tx(cutOps(cur, merged.map((r) => ({ ...r, reason: 'director' as never, label: 'Director cut' }))));
  const map = (t: number) => mapThroughCuts(t, merged);
  const preview: PreviewItem[] = [];
  for (const { a, index } of chosen) {
    const s0 = Math.round(a.start * 1e6), e0 = Math.round(a.end * 1e6);
    counts[a.type]++;
    if (a.type === 'cut') { preview.push({ index, type: a.type, label: `Cut ${f(s0)} to ${f(e0)} s (${f(e0 - s0)} s)`, reason: a.reason.trim(), startUs: s0, endUs: e0 }); continue; }
    const s = map(s0), e = map(e0);
    if (a.type !== 'marker' && e - s < 50_000) { problems.push({ index, reason: `${a.type} ${a.start}-${a.end} s: falls inside a cut` }); continue; }
    if (a.type === 'zoom') {
      const lane = (['camera', 'screen'] as const).map((k) => laneOfKind(cur, k)).find((l) => l?.clips.some((x) => x.kind === 'media' && x.start <= s && clipEnd(x) > s));
      const c = lane?.clips.find((x) => x.kind === 'media' && x.start <= s && clipEnd(x) > s);
      if (!c) { problems.push({ index, reason: `zoom ${a.start}-${a.end} s: no camera clip after cuts` }); continue; }
      const fx = { id: uid('fx'), type: 'zoom', enabled: true, params: { at: s - c.start, amount: Math.round(a.amount * 100) / 100, ramp: 140_000, until: Math.min(e, clipEnd(c)) - c.start } };
      tx([{ op: 'updateClip', id: c.id, patch: { effects: [...findClip(cur, c.id)!.clip.effects, fx] } }]);
      preview.push({ index, type: a.type, label: `Zoom ${a.amount.toFixed(2)}x ${f(s0)} to ${f(e0)} s`, reason: a.reason.trim(), startUs: s, endUs: e });
    } else if (a.type === 'broll') {
      const lane = laneOfKind(cur, 'broll');
      if (!lane) { problems.push({ index, reason: 'broll: the project has no B-roll lane' }); continue; }
      if (lane.clips.some((x) => x.start < e && clipEnd(x) > s)) { problems.push({ index, reason: `broll ${a.start}-${a.end} s: overlaps existing b-roll` }); continue; }
      tx([{ op: 'addClip', laneId: lane.id, clip: newClip({ kind: 'placeholder', start: s, out: e - s, name: `B-roll: ${a.text.trim().slice(0, 80)}` }) }]);
      preview.push({ index, type: a.type, label: `B-roll "${a.text.trim().slice(0, 60)}" ${f(s0)} to ${f(e0)} s`, reason: a.reason.trim(), startUs: s, endUs: e });
    } else if (a.type === 'text') {
      const lane = laneOfKind(cur, 'titles');
      if (!lane) { problems.push({ index, reason: 'text: the project has no Titles lane' }); continue; }
      if (lane.clips.some((x) => x.start < e && clipEnd(x) > s)) { problems.push({ index, reason: `text ${a.start}-${a.end} s: overlaps an existing title` }); continue; }
      tx([{ op: 'addClip', laneId: lane.id, clip: newClip({ kind: 'text', start: s, out: e - s, name: 'Director title', text: defaultText(a.text.trim(), { size: 88, weight: 800 }) }) }]);
      preview.push({ index, type: a.type, label: `Title "${a.text.trim().slice(0, 60)}" ${f(s0)} to ${f(e0)} s`, reason: a.reason.trim(), startUs: s, endUs: e });
    } else {
      tx([{ op: 'addMarker', marker: { id: uid('mk'), t: Math.min(s, timelineDuration(cur)), kind: 'note', label: (a.text.trim() || a.reason.trim()).slice(0, 200) } }]);
      preview.push({ index, type: a.type, label: `Marker at ${f(s0)} s: ${(a.text.trim() || a.reason.trim()).slice(0, 60)}`, reason: a.reason.trim(), startUs: s, endUs: s });
    }
  }
  if (problems.length) return empty();
  preview.sort((x, y) => x.index - y.index);
  return { ok: true, ops, problems: [], preview, before: D, after: timelineDuration(cur), removedUs: D - timelineDuration(cur), counts };
}

export interface DirectorResult { summary: string; actions: DirectorAction[]; plan: DirectorPlan; record: CallRecord }

export async function runDirector(client: ClaudeClient, doc: Project, opts: { goal: string; reference?: Pacing | null; targetSec?: number | null }): Promise<DirectorResult> {
  const words = timelineWords(doc);
  const { data, record } = await client.call({
    task: 'director',
    system: DIRECTOR_SYSTEM,
    prompt: directorPrompt(doc, words, opts),
    schema: DirectorSchema,
    effort: 'high',
  });
  return { summary: data.summary.trim(), actions: data.actions, plan: compileDirector(doc, data.actions), record };
}
