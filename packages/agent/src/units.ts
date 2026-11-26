import { z } from 'zod';
import {
  findClip, LANE_ORDER, snapToFrame, timelineDuration, clipEnd, clipDuration, EFFECT_DEFS,
  type Animatable, type Clip, type Lane, type LaneKind, type Project,
} from '@director/engine';
import { AgentError } from './core';

/** Seconds (agent) to microseconds (engine). */
export const us = (s: number): number => Math.round(s * 1e6);
/** Microseconds to seconds, rounded to the millisecond. */
export const sec = (t: number): number => Math.round(t / 1000) / 1000;
/** Seconds to microseconds on the project's frame grid. */
export const frameUs = (doc: Project, s: number): number => snapToFrame(us(s), doc.canvas.fps);

export const Seconds = z.number().min(0).max(36_000);
export const SecondsDelta = z.number().min(-36_000).max(36_000);
export const Ref = z.string().min(1).max(64);
export const LaneRef = z.string().min(1).max(100).describe('Lane id, or a lane kind (camera, screen, broll, graphics, titles, captions, voice, music, sfx)');
export const Color = z.string().regex(/^#([0-9a-f]{6}|[0-9a-f]{8})$|^rgba?\([\d.,\s]+\)$/i, 'a color like #ffcc00 or rgba(0,0,0,0.6)');

export function lanesList(doc: Project): string {
  return doc.lanes.map((l) => `${l.id} (${l.kind}${l.name !== l.kind ? `, "${l.name}"` : ''})`).join(', ');
}

/** A lane by id, kind or name. */
export function laneRef(doc: Project, ref: string, opts: { unlocked?: boolean } = {}): Lane {
  const r = ref.trim();
  const lane = doc.lanes.find((l) => l.id === r)
    ?? doc.lanes.find((l) => l.kind === r.toLowerCase())
    ?? doc.lanes.find((l) => l.name.toLowerCase() === r.toLowerCase())
    ?? (r.toLowerCase() === 'b-roll' ? doc.lanes.find((l) => l.kind === 'broll') : undefined);
  if (!lane) {
    const isKind = (LANE_ORDER as string[]).includes(r.toLowerCase());
    throw new AgentError('LANE_NOT_FOUND', `No lane "${ref}" in this project. Lanes: ${lanesList(doc)}.`, isKind ? `Add one with add_lane {"kind":"${r.toLowerCase()}"}.` : 'Use a lane id or kind from get_timeline.');
  }
  if (opts.unlocked && lane.locked) throw new AgentError('LANE_LOCKED', `Lane ${lane.id} (${lane.kind}) is locked.`, `Unlock it with update_lane {"lane":"${lane.id}","locked":false}.`);
  return lane;
}

export function clipRef(doc: Project, id: string, opts: { unlocked?: boolean } = {}): { clip: Clip; lane: Lane } {
  const loc = findClip(doc, id);
  if (!loc) throw new AgentError('CLIP_NOT_FOUND', `No clip "${id}" in this project.`, 'Clip ids come from get_timeline. Splits and cuts create new ids for the right-hand parts, so read the timeline again after them.');
  if (opts.unlocked && loc.lane.locked) throw new AgentError('LANE_LOCKED', `Clip ${id} is on locked lane ${loc.lane.id} (${loc.lane.kind}).`, `Unlock it with update_lane {"lane":"${loc.lane.id}","locked":false}.`);
  return { clip: loc.clip, lane: loc.lane };
}

export function mediaRef(doc: Project, ref: string) {
  const m = doc.media[ref] ?? Object.values(doc.media).find((x) => x.name === ref);
  if (!m) throw new AgentError('MEDIA_NOT_FOUND', `No media "${ref}" in this project's bin.`, 'list_media shows what is imported; import_media adds files.');
  return m;
}

export function inTimeline(doc: Project, t: number, what = 'time'): void {
  const end = timelineDuration(doc);
  if (t > end) throw new AgentError('PAST_END', `${what} ${sec(t)} s is past the end of the timeline (${sec(end)} s).`, 'Read the length with get_timeline (durationSec).');
}

export function insideClip(c: Clip, t: number, what = 'time'): void {
  if (t <= c.start || t >= clipEnd(c)) throw new AgentError('OUTSIDE_CLIP', `${what} ${sec(t)} s is not inside clip ${c.id}, which runs ${sec(c.start)} to ${sec(clipEnd(c))} s.`, 'Pick a time between the clip start and end (timeline seconds), from get_clip.');
}

/** Animatable value as the agent sees it: value plus keyframes in timeline and clip seconds. */
export function animView(a: Animatable, clipStart: number) {
  return a.keyframes?.length
    ? { value: a.value, keyframes: a.keyframes.map((k) => ({ time: sec(clipStart + k.t), clipTime: sec(k.t), value: k.v, ease: k.ease })) }
    : a.value;
}

export function effectView(c: Clip) {
  return c.effects.map((e) => {
    const def = EFFECT_DEFS[e.type];
    const params: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e.params)) {
      const isTime = def?.params.find((p) => p.key === k)?.unit === 's';
      if (typeof v === 'number') params[k] = isTime ? sec(v) : v;
      else if (typeof v === 'object' && v) params[k] = animView(v, c.start);
      else params[k] = typeof v === 'string' && def?.extras?.find((x) => x.key === k)?.kind === 'path' ? v.split('/').pop() : v;
    }
    return { id: e.id, type: e.type, enabled: e.enabled, params };
  });
}

export function clipSummary(doc: Project, c: Clip, lane: Lane) {
  const m = c.mediaId ? doc.media[c.mediaId] : undefined;
  return {
    id: c.id, lane: lane.id, laneKind: lane.kind, kind: c.kind,
    name: c.name ?? m?.name ?? c.text?.content?.slice(0, 60) ?? c.kind,
    start: sec(c.start), end: sec(clipEnd(c)), duration: sec(clipDuration(c)),
    ...(m ? { media: m.id } : {}),
    ...(c.text ? { text: c.text.content.slice(0, 200) } : {}),
    ...(c.effects.length ? { effects: c.effects.map((e) => e.type) } : {}),
    ...(c.transitionIn ? { transitionIn: c.transitionIn.type } : {}),
    ...(c.speed.kind === 'ramp' ? { speed: 'ramp' } : c.speed.rate !== 1 ? { speed: c.speed.rate } : {}),
    ...(c.enabled ? {} : { enabled: false }),
    ...(c.linkGroup ? { link: c.linkGroup } : {}),
  };
}

export function clipDetail(doc: Project, c: Clip, lane: Lane) {
  const m = c.mediaId ? doc.media[c.mediaId] : undefined;
  const t = c.transform;
  return {
    ...clipSummary(doc, c, lane),
    sourceIn: sec(c.in), sourceOut: sec(c.out),
    ...(m ? { mediaInfo: { name: m.name, kind: m.kind, duration: sec(m.durationUs), width: m.width, height: m.height, hasAudio: m.hasAudio, role: m.role } } : {}),
    speed: c.speed.kind === 'constant' ? { rate: c.speed.rate, preservePitch: c.speed.preservePitch } : { ramp: c.speed.points, preservePitch: c.speed.preservePitch },
    reverse: c.reverse,
    ...(c.freezeAt != null ? { freezeAt: sec(c.freezeAt) } : {}),
    enabled: c.enabled,
    fit: c.fit ?? 'cover', blend: c.blend,
    transform: {
      x: animView(t.x, c.start), y: animView(t.y, c.start), scale: animView(t.scale, c.start),
      rotation: animView(t.rotation, c.start), opacity: animView(t.opacity, c.start),
      crop: t.crop, flipH: t.flipH, flipV: t.flipV,
    },
    effects: effectView(c),
    ...(c.audio ? { audio: { volume: animView(c.audio.gainDb, c.start), pan: c.audio.pan, fadeIn: sec(c.audio.fadeIn), fadeOut: sec(c.audio.fadeOut), muted: c.audio.muted, duckUnderVoice: c.audio.duckable } } : {}),
    ...(c.text ? { textStyle: { ...c.text, words: undefined, content: c.text.content, animationDuration: c.text.animationDuration != null ? sec(c.text.animationDuration) : undefined } } : {}),
    ...(c.shape ? { shape: c.shape } : {}),
    ...(c.transitionIn ? { transitionIn: { type: c.transitionIn.type, duration: sec(c.transitionIn.duration) } } : {}),
    ...(c.color ? { color: c.color } : {}),
  };
}

export const LANE_KINDS = LANE_ORDER as [LaneKind, ...LaneKind[]];
