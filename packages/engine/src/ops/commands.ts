import type { Animatable, Clip, Lane, Project, Speed, Word } from '../schema/project';
import { AUDIO_LANES } from '../schema/project';
import { applyOp, OpError, type Op } from './primitives';
import { clipDuration, clipEnd, evalAnim, findClip, newClip, rampIntegral, sourceTimeAt, uid } from '../model';
import type { Micros } from '../time';

/** Builds a command by applying ops to a working copy as it goes, so later steps see earlier ones. */
export class Tx {
  readonly ops: Op[] = [];
  public doc: Project;
  constructor(doc: Project) { this.doc = doc;}
  do(op: Op): this {
    this.doc = applyOp(this.doc, op).doc;
    this.ops.push(op);
    return this;
  }
}

const MIN_DUR = 1000; // 1 ms, below any frame

function splitAnim(a: Animatable, rel: Micros): [Animatable, Animatable] {
  if (!a.keyframes || a.keyframes.length === 0) return [a, a];
  const v = evalAnim(a, rel);
  const seg = [...a.keyframes].reverse().find((k) => k.t <= rel);
  const ease = seg?.ease ?? 'linear';
  const left = a.keyframes.filter((k) => k.t < rel);
  left.push({ t: rel, v, ease });
  const right = [{ t: 0, v, ease }, ...a.keyframes.filter((k) => k.t > rel).map((k) => ({ ...k, t: k.t - rel }))];
  return [{ value: a.value, keyframes: left }, { value: a.value, keyframes: right }];
}

function shiftAnim(a: Animatable, delta: Micros): Animatable {
  if (!a.keyframes || a.keyframes.length === 0) return a;
  if (delta === 0) return a;
  const [, right] = splitAnim(a, delta);
  return delta > 0 ? right : { value: a.value, keyframes: a.keyframes.map((k) => ({ ...k, t: k.t - delta })) };
}

function splitWords(words: Word[] | undefined, rel: Micros): [Word[] | undefined, Word[] | undefined] {
  if (!words) return [undefined, undefined];
  const left = words.filter((w) => w.start < rel).map((w) => ({ ...w, end: Math.min(w.end, rel) }));
  const right = words.filter((w) => w.end > rel).map((w) => ({ ...w, start: Math.max(0, w.start - rel), end: w.end - rel }));
  return [left, right];
}

function splitSpeed(s: Speed, x0: number): [Speed, Speed] {
  if (s.kind === 'constant') return [s, s];
  const rateAt = (x: number) => {
    const p = s.points;
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!; const b = p[i + 1]!;
      if (x >= a.at && x <= b.at) return b.at === a.at ? a.rate : a.rate + ((b.rate - a.rate) * (x - a.at)) / (b.at - a.at);
    }
    return p[p.length - 1]!.rate;
  };
  const leftPts = [...s.points.filter((p) => p.at < x0), { at: x0, rate: rateAt(x0) }].map((p) => ({ at: p.at / x0, rate: p.rate }));
  const rightPts = [{ at: x0, rate: rateAt(x0) }, ...s.points.filter((p) => p.at > x0)].map((p) => ({ at: (p.at - x0) / (1 - x0), rate: p.rate }));
  return [{ ...s, points: leftPts }, { ...s, points: rightPts }];
}

function mapTransform(c: Clip, f: (a: Animatable) => Animatable): Clip['transform'] {
  const t = c.transform;
  return { ...t, x: f(t.x), y: f(t.y), scale: f(t.scale), rotation: f(t.rotation), opacity: f(t.opacity) };
}

function mapEffects(c: Clip, f: (a: Animatable) => Animatable): Clip['effects'] {
  return c.effects.map((e) => ({
    ...e,
    params: Object.fromEntries(Object.entries(e.params).map(([k, v]) => [k, typeof v === 'object' && v !== null ? f(v) : v])),
  }));
}

/** Compute the two halves of a clip split at timeline time `at`. */
export function splitClipParts(c: Clip, at: Micros, rightId: string, rightLink?: string): { left: Clip; right: Clip } {
  const d = clipDuration(c);
  const rel = at - c.start;
  if (rel <= 0 || rel >= d) throw new OpError(`split point ${at} is outside clip ${c.id}`, 'RANGE');
  const pick = (i: 0 | 1) => (a: Animatable) => splitAnim(a, rel)[i];
  let lIn = c.in, lOut = c.out, rIn = c.in, rOut = c.out;
  if (c.freezeAt != null) {
    lOut = c.in + rel; rIn = c.in + rel;
  } else {
    const s = sourceTimeAt(c, at);
    if (c.reverse) { lIn = s; rOut = s; } else { lOut = s; rIn = s; }
  }
  const [ls, rs] = splitSpeed(c.speed, rel / d);
  const [lw, rw] = splitWords(c.text?.words, rel);
  const left: Clip = {
    ...c,
    in: lIn, out: Math.max(lIn + MIN_DUR, lOut), speed: ls,
    transform: mapTransform(c, pick(0)), effects: mapEffects(c, pick(0)),
    audio: c.audio ? { ...c.audio, gainDb: pick(0)(c.audio.gainDb), fadeOut: 0 } : undefined,
    text: c.text ? { ...c.text, words: lw } : undefined,
  };
  const right: Clip = {
    ...c,
    id: rightId,
    start: at,
    in: rIn, out: Math.max(rIn + MIN_DUR, rOut), speed: rs,
    transform: mapTransform(c, pick(1)), effects: mapEffects(c, pick(1)),
    audio: c.audio ? { ...c.audio, gainDb: pick(1)(c.audio.gainDb), fadeIn: 0 } : undefined,
    text: c.text ? { ...c.text, words: rw } : undefined,
    transitionIn: undefined,
    linkGroup: c.linkGroup ? rightLink ?? c.linkGroup : undefined,
  };
  if (!left.audio) delete (left as Partial<Clip>).audio;
  if (!right.audio) delete (right as Partial<Clip>).audio;
  if (!left.text) delete (left as Partial<Clip>).text;
  if (!right.text) delete (right as Partial<Clip>).text;
  if (!right.transitionIn) delete (right as Partial<Clip>).transitionIn;
  if (!right.linkGroup) delete (right as Partial<Clip>).linkGroup;
  return { left, right };
}

function patchFromClip(before: Clip, after: Clip): { patch: Partial<Clip>; unset: string[] } {
  const patch: Record<string, unknown> = {};
  const unset: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (k === 'id') continue;
    const a = (before as Record<string, unknown>)[k];
    const b = (after as Record<string, unknown>)[k];
    if (b === undefined) { if (a !== undefined) unset.push(k); continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) patch[k] = b;
  }
  return { patch: patch as Partial<Clip>, unset };
}

function replaceClip(tx: Tx, before: Clip, after: Clip): void {
  const { patch, unset } = patchFromClip(before, after);
  if (Object.keys(patch).length || unset.length) tx.do({ op: 'updateClip', id: before.id, patch, unset: unset.length ? unset : undefined });
}

function splitInTx(tx: Tx, clipId: string, at: Micros, rightId = uid('clip'), rightLink?: string): string | null {
  const loc = findClip(tx.doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const c = loc.clip;
  if (at <= c.start || at >= clipEnd(c)) return null;
  const { left, right } = splitClipParts(c, at, rightId, rightLink);
  replaceClip(tx, c, left);
  tx.do({ op: 'addClip', laneId: loc.lane.id, clip: right });
  return rightId;
}

function linkedIds(doc: Project, clipId: string): string[] {
  const loc = findClip(doc, clipId);
  if (!loc) return [];
  const g = loc.clip.linkGroup;
  if (!g) return [clipId];
  return doc.lanes.flatMap((l) => l.clips.filter((c) => c.linkGroup === g).map((c) => c.id));
}

/** Split the given clips (and their linked partners) at `at`. Returns ops. */
export function splitOps(doc: Project, clipIds: string[], at: Micros): Op[] {
  const tx = new Tx(doc);
  const ids = new Set(clipIds.flatMap((id) => linkedIds(doc, id)));
  const newLinks = new Map<string, string>();
  for (const id of ids) {
    const loc = findClip(tx.doc, id);
    if (!loc || loc.lane.locked) continue;
    const g = loc.clip.linkGroup;
    let rl: string | undefined;
    if (g) { rl = newLinks.get(g) ?? uid('link'); newLinks.set(g, rl); }
    splitInTx(tx, id, at, uid('clip'), rl);
  }
  return tx.ops;
}

/** Split every clip on unlocked lanes that crosses `at` (the blade-all tool). */
export function splitAllAtOps(doc: Project, at: Micros, laneIds?: string[]): Op[] {
  const ids = doc.lanes
    .filter((l) => !l.locked && (!laneIds || laneIds.includes(l.id)))
    .flatMap((l) => l.clips.filter((c) => c.start < at && at < clipEnd(c)).map((c) => c.id));
  return splitOps(doc, ids, at);
}

/** Remove content in [from, to) on one lane without moving anything else (lift / overwrite). */
function liftRangeInTx(tx: Tx, laneId: string, from: Micros, to: Micros, except: Set<string> = new Set()): void {
  const lane = () => tx.doc.lanes.find((l) => l.id === laneId)!;
  for (const c of [...lane().clips]) {
    if (except.has(c.id)) continue;
    const s = c.start, e = clipEnd(c);
    if (e <= from || s >= to) continue;
    if (s >= from && e <= to) { tx.do({ op: 'removeClip', id: c.id }); continue; }
    if (s < from && e > to) {
      const mid = splitInTx(tx, c.id, from)!;
      const tail = splitInTx(tx, mid, to)!;
      void tail;
      tx.do({ op: 'removeClip', id: mid });
      continue;
    }
    if (s < from) {
      const right = splitInTx(tx, c.id, from)!;
      tx.do({ op: 'removeClip', id: right });
      continue;
    }
    // s >= from && e > to: trim the head off in place so the surviving part keeps its id.
    const { right } = splitClipParts(c, to, c.id);
    replaceClip(tx, c, { ...right, id: c.id, transitionIn: c.transitionIn, linkGroup: c.linkGroup });
  }
}

export function liftRangeOps(doc: Project, laneId: string, from: Micros, to: Micros): Op[] {
  const tx = new Tx(doc);
  liftRangeInTx(tx, laneId, from, to);
  return tx.ops;
}

function shiftInTx(tx: Tx, laneIds: string[] | null, fromT: Micros, delta: Micros, shiftMarkers: boolean): void {
  if (delta === 0) return;
  for (const lane of tx.doc.lanes) {
    if (lane.locked) continue;
    if (laneIds && !laneIds.includes(lane.id)) continue;
    const movers = lane.clips.filter((c) => c.start >= fromT);
    // Move in an order that never creates transient negative starts.
    for (const c of movers) tx.do({ op: 'updateClip', id: c.id, patch: { start: Math.max(0, c.start + delta) } });
  }
  if (shiftMarkers) for (const m of tx.doc.markers.filter((m) => m.t >= fromT)) tx.do({ op: 'updateMarker', id: m.id, patch: { t: Math.max(0, m.t + delta) } });
}

/**
 * Remove [from, to) across lanes and close the gap (ripple). The core of transcript edits and AutoCut.
 * Markers inside the range are removed; later markers shift.
 */
export function rippleDeleteRangeOps(doc: Project, from: Micros, to: Micros, laneIds?: string[]): Op[] {
  if (to <= from) return [];
  const tx = new Tx(doc);
  const lanes = doc.lanes.filter((l) => !l.locked && (!laneIds || laneIds.includes(l.id))).map((l) => l.id);
  for (const id of lanes) liftRangeInTx(tx, id, from, to);
  if (!laneIds) for (const m of tx.doc.markers.filter((m) => m.t >= from && m.t < to)) tx.do({ op: 'removeMarker', id: m.id });
  shiftInTx(tx, lanes, to, -(to - from), !laneIds);
  return tx.ops;
}

/** Apply many ripple deletes at once. Ranges are processed from the end so earlier times stay valid. */
export function rippleDeleteRangesOps(doc: Project, ranges: Array<{ from: Micros; to: Micros }>, laneIds?: string[]): Op[] {
  const merged = mergeRanges(ranges);
  const tx = new Tx(doc);
  for (const r of merged.reverse()) for (const op of rippleDeleteRangeOps(tx.doc, r.from, r.to, laneIds)) tx.do(op);
  return tx.ops;
}

export function mergeRanges(ranges: Array<{ from: Micros; to: Micros }>): Array<{ from: Micros; to: Micros }> {
  const sorted = ranges.filter((r) => r.to > r.from).map((r) => ({ ...r })).sort((a, b) => a.from - b.from);
  const out: Array<{ from: Micros; to: Micros }> = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push(r);
  }
  return out;
}

/** Delete clips (with linked partners). With ripple, later clips on the same lanes move left to close the gap. */
export function deleteClipsOps(doc: Project, clipIds: string[], ripple: boolean): Op[] {
  const tx = new Tx(doc);
  const ids = [...new Set(clipIds.flatMap((id) => linkedIds(doc, id)))];
  const targets = ids.map((id) => findClip(doc, id)).filter((x): x is NonNullable<typeof x> => !!x && !x.lane.locked);
  // Process latest first so ripple shifts do not disturb pending ranges.
  targets.sort((a, b) => b.clip.start - a.clip.start);
  for (const t of targets) {
    const cur = findClip(tx.doc, t.clip.id);
    if (!cur) continue;
    const s = cur.clip.start;
    const e = clipEnd(cur.clip);
    tx.do({ op: 'removeClip', id: cur.clip.id });
    if (ripple) {
      const lane = tx.doc.lanes.find((l) => l.id === cur.lane.id)!;
      const blocked = lane.clips.some((c) => c.start < e && clipEnd(c) > s);
      if (!blocked) shiftInTx(tx, [cur.lane.id], e, -(e - s), false);
    }
  }
  return tx.ops;
}

/** Move a clip (and its linked partners by the same delta). Overwrites whatever is under the destination. */
export function moveClipOps(doc: Project, clipId: string, toLaneId: string, toStart: Micros): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const tx = new Tx(doc);
  const delta = Math.max(-loc.clip.start, toStart - loc.clip.start);
  const ids = linkedIds(doc, clipId);
  const moving = new Set(ids);
  for (const id of ids) {
    const cur = findClip(tx.doc, id)!;
    const laneId = id === clipId ? toLaneId : cur.lane.id;
    const ns = Math.max(0, cur.clip.start + delta);
    const ne = ns + clipDuration(cur.clip);
    if (laneId !== cur.lane.id) tx.do({ op: 'moveClipToLane', id, laneId });
    liftRangeInTx(tx, laneId, ns, ne, moving);
    if (ns !== cur.clip.start) tx.do({ op: 'updateClip', id, patch: { start: ns } });
  }
  return tx.ops;
}

export interface TrimOptions { ripple?: boolean; mediaDuration?: Micros }

/** Trim a clip edge to timeline time `to`. */
export function trimOps(doc: Project, clipId: string, edge: 'start' | 'end', to: Micros, opts: TrimOptions = {}): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const c = loc.clip;
  const tx = new Tx(doc);
  const media = c.mediaId ? doc.media[c.mediaId] : undefined;
  const maxSource = opts.mediaDuration ?? (media && media.kind !== 'image' ? media.durationUs : Number.MAX_SAFE_INTEGER);
  const rate = c.speed.kind === 'constant' ? c.speed.rate : rampIntegral(c.speed.points, 1);
  const oldEnd = clipEnd(c);
  if (edge === 'end') {
    let newDur = Math.max(MIN_DUR, to - c.start);
    let newOut = c.reverse ? c.out : Math.round(c.in + newDur * rate);
    let newIn = c.reverse ? Math.round(c.out - newDur * rate) : c.in;
    if (!c.reverse && newOut > maxSource) { newOut = maxSource; newDur = Math.round((newOut - c.in) / rate); }
    if (c.reverse && newIn < 0) { newIn = 0; newDur = Math.round((c.out - newIn) / rate); }
    if (c.freezeAt != null) { newIn = c.in; newOut = c.in + newDur; }
    const after: Clip = { ...c, in: newIn, out: newOut };
    if (after.text?.words) after.text = { ...after.text, words: after.text.words.filter((w) => w.start < newDur).map((w) => ({ ...w, end: Math.min(w.end, newDur) })) };
    replaceClip(tx, c, after);
    const newEnd = clipEnd({ ...after });
    if (opts.ripple) shiftInTx(tx, [loc.lane.id], oldEnd, newEnd - oldEnd, false);
    return tx.ops;
  }
  // start edge
  let delta = to - c.start; // positive trims in
  const maxDelta = clipDuration(c) - MIN_DUR;
  delta = Math.min(delta, maxDelta);
  let srcDelta = Math.round(delta * rate);
  if (!c.reverse && c.freezeAt == null && c.in + srcDelta < 0) { srcDelta = -c.in; delta = Math.round(srcDelta / rate); }
  if (c.reverse && c.out - srcDelta > maxSource) { srcDelta = c.out - maxSource; delta = Math.round(srcDelta / rate); }
  if (delta < 0 && c.start + delta < 0) { delta = -c.start; srcDelta = Math.round(delta * rate); }
  const after: Clip = {
    ...c,
    start: opts.ripple ? c.start : c.start + delta,
    in: c.reverse ? c.in : c.freezeAt != null ? c.in : c.in + srcDelta,
    out: c.reverse ? c.out - srcDelta : c.freezeAt != null ? c.out - delta : c.out,
    transform: mapTransform(c, (a) => shiftAnim(a, delta)),
    effects: mapEffects(c, (a) => shiftAnim(a, delta)),
  };
  if (c.audio) after.audio = { ...c.audio, gainDb: shiftAnim(c.audio.gainDb, delta) };
  if (c.text?.words) after.text = { ...c.text, words: c.text.words.filter((w) => w.end > delta).map((w) => ({ ...w, start: Math.max(0, w.start - delta), end: w.end - delta })) };
  replaceClip(tx, c, after);
  if (opts.ripple) shiftInTx(tx, [loc.lane.id], oldEnd, -delta, false);
  return tx.ops;
}

/** Slip: change the source range without moving the clip on the timeline. */
export function slipOps(doc: Project, clipId: string, delta: Micros): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const c = loc.clip;
  const media = c.mediaId ? doc.media[c.mediaId] : undefined;
  const max = media?.durationUs ?? Number.MAX_SAFE_INTEGER;
  const d = Math.max(-c.in, Math.min(delta, max - c.out));
  if (d === 0) return [];
  return [{ op: 'updateClip', id: clipId, patch: { in: c.in + d, out: c.out + d } }];
}

/** Roll the edit point between two adjacent clips on the same lane. */
export function rollOps(doc: Project, leftId: string, rightId: string, delta: Micros): Op[] {
  const l = findClip(doc, leftId);
  const r = findClip(doc, rightId);
  if (!l || !r || l.lane.id !== r.lane.id) throw new OpError('roll needs two clips on the same lane', 'RANGE');
  const tx = new Tx(doc);
  const edit = clipEnd(l.clip) + delta;
  for (const op of trimOps(tx.doc, leftId, 'end', edit)) tx.do(op);
  for (const op of trimOps(tx.doc, rightId, 'start', edit)) tx.do(op);
  return tx.ops;
}

/** Insert a clip. With ripple, everything at or after the insert point on unlocked lanes moves right. */
export function insertClipOps(doc: Project, laneId: string, clip: Clip, ripple: boolean): Op[] {
  const tx = new Tx(doc);
  const dur = clipDuration(clip);
  if (ripple) {
    for (const lane of doc.lanes.filter((x) => !x.locked)) {
      for (const c of lane.clips.filter((c) => c.start < clip.start && clipEnd(c) > clip.start)) splitInTx(tx, c.id, clip.start);
    }
    shiftInTx(tx, null, clip.start, dur, true);
  } else {
    liftRangeInTx(tx, laneId, clip.start, clip.start + dur);
  }
  tx.do({ op: 'addClip', laneId, clip });
  return tx.ops;
}

export function setSpeedOps(doc: Project, clipId: string, rate: number, ripple: boolean): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const tx = new Tx(doc);
  const before = clipEnd(loc.clip);
  const speed: Speed = { kind: 'constant', rate, preservePitch: loc.clip.speed.preservePitch };
  tx.do({ op: 'updateClip', id: clipId, patch: { speed } });
  const after = clipEnd(findClip(tx.doc, clipId)!.clip);
  if (ripple && after !== before) shiftInTx(tx, [loc.lane.id], before, after - before, false);
  else if (!ripple && after > before) liftRangeInTx(tx, loc.lane.id, before, after, new Set([clipId]));
  return tx.ops;
}

/** Split off the audio of a video clip onto an audio lane, linked to the original. */
export function detachAudioOps(doc: Project, clipId: string, toLaneId: string): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const c = loc.clip;
  if (!c.audio) throw new OpError('clip has no audio', 'RANGE');
  const target = doc.lanes.find((l) => l.id === toLaneId);
  if (!target || !AUDIO_LANES.has(target.kind)) throw new OpError('target must be an audio lane', 'RANGE');
  const tx = new Tx(doc);
  const link = c.linkGroup ?? uid('link');
  const audioClip = newClip({ ...structuredClone(c), id: uid('clip'), linkGroup: link, transform: c.transform, effects: [] });
  if (!c.linkGroup) tx.do({ op: 'updateClip', id: c.id, patch: { linkGroup: link } });
  tx.do({ op: 'updateClip', id: c.id, patch: { audio: { ...c.audio, muted: true } } });
  liftRangeInTx(tx, toLaneId, c.start, clipEnd(c));
  tx.do({ op: 'addClip', laneId: toLaneId, clip: { ...audioClip, audio: { ...c.audio, muted: false } } });
  return tx.ops;
}

export function duplicateClipOps(doc: Project, clipId: string, at?: Micros): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const tx = new Tx(doc);
  const start = at ?? clipEnd(loc.clip);
  const copy: Clip = { ...structuredClone(loc.clip), id: uid('clip'), start };
  delete (copy as Partial<Clip>).linkGroup;
  liftRangeInTx(tx, loc.lane.id, start, start + clipDuration(copy));
  tx.do({ op: 'addClip', laneId: loc.lane.id, clip: copy });
  return tx.ops;
}

export function laneEnd(lane: Lane): Micros {
  return lane.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

/** Snap candidates: clip edges, playhead, markers. Returns the snapped time or the input. */
export function snapTime(doc: Project, t: Micros, threshold: Micros, extra: Micros[] = [], exclude: Set<string> = new Set()): { t: Micros; snapped: boolean } {
  let best = t;
  let bestD = threshold + 1;
  const consider = (x: Micros) => { const d = Math.abs(x - t); if (d < bestD) { bestD = d; best = x; } };
  for (const lane of doc.lanes) for (const c of lane.clips) { if (exclude.has(c.id)) continue; consider(c.start); consider(clipEnd(c)); }
  for (const m of doc.markers) consider(m.t);
  for (const x of extra) consider(x);
  consider(0);
  return bestD <= threshold ? { t: best, snapped: true } : { t, snapped: false };
}
