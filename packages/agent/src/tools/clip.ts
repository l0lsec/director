import { z } from 'zod';
import {
  RAMP_PRESETS, Tx, clipDuration, clipEnd, detachAudioOps, freezeFrameOps, pipOps, setRampOps, setSpeedOps,
  type Animatable, type Clip, type Ease, type Op, type PipLayout, type Speed, EASES, BLEND_MODES, FIT_MODES,
} from '@director/engine';
import { AgentError, defineEdit } from '../core';
import { LaneRef, Ref, Seconds, clipRef, frameUs, insideClip, laneRef, sec, us } from '../units';

const Anim = z.number();
const Crop = z.object({ left: z.number().min(0).max(0.95), top: z.number().min(0).max(0.95), right: z.number().min(0).max(0.95), bottom: z.number().min(0).max(0.95) }).partial();
export const LAYOUTS = ['full', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'split-top', 'split-bottom'] as const;
const KeyframeIn = z.object({ time: z.number().min(-36_000).max(36_000).describe('Seconds (timeline time by default; see timeBase)'), value: z.number(), ease: z.enum(EASES).optional().describe('Easing into the next keyframe (default ease)') });
export const KEYFRAME_PROPERTIES = ['x', 'y', 'scale', 'rotation', 'opacity', 'volume', 'effect'] as const;

/** Static value for an animatable: drops keyframes. */
const still = (v: number): Animatable => ({ value: v });

function toKeyframes(c: Clip, kfs: Array<{ time: number; value: number; ease?: Ease }>, base: 'timeline' | 'clip'): Animatable {
  const dur = clipDuration(c);
  const pts = kfs.map((k) => ({ t: Math.round(base === 'clip' ? us(k.time) : us(k.time) - c.start), v: k.value, ease: k.ease ?? 'ease' as Ease }));
  for (const p of pts) if (p.t < 0 || p.t > dur + 1000) throw new AgentError('OUTSIDE_CLIP', `Keyframe at ${base === 'clip' ? sec(p.t) : sec(p.t + c.start)} s is outside clip ${c.id} (${sec(c.start)} to ${sec(clipEnd(c))} s on the timeline).`, base === 'timeline' ? 'Keyframe times are timeline seconds by default; pass timeBase:"clip" to give seconds from the clip start.' : 'Clip-relative times run from 0 to the clip duration.');
  pts.sort((a, b) => a.t - b.t);
  return { value: pts[0]?.v ?? 0, keyframes: pts.map((p) => ({ ...p, t: Math.min(p.t, dur) })) };
}

export const clipTools = [
  defineEdit({
    name: 'set_clip', title: 'Set clip properties', group: 'clip', idempotent: true,
    description: 'Set static properties of one or more clips: position x/y (pixels from the frame center, +x right, +y down), scale (1 = fills the frame per fit), rotation (degrees), opacity (0 to 1), crop (fractions of each side), flips, fit, blend mode, reverse playback, enabled (false hides and silences it), name and label color. Setting a property that has keyframes replaces the animation with the fixed value; use set_keyframes to animate.',
    input: {
      clips: z.array(Ref).min(1).max(200),
      x: Anim.optional(), y: Anim.optional(), scale: z.number().min(0.01).max(20).optional(), rotation: z.number().min(-3600).max(3600).optional(), opacity: z.number().min(0).max(1).optional(),
      crop: Crop.optional(), flipH: z.boolean().optional(), flipV: z.boolean().optional(),
      fit: z.enum(FIT_MODES).optional(), blend: z.enum(BLEND_MODES).optional(),
      reverse: z.boolean().optional(), enabled: z.boolean().optional(),
      name: z.string().max(200).optional(), color: z.string().max(32).optional().describe('Timeline label color'),
    },
    examples: [{ args: { clips: ['clip_abc'], scale: 1.2, y: -80 }, note: 'Punch in 20% and move up' }, { args: { clips: ['clip_abc'], crop: { left: 0.1, right: 0.1 }, opacity: 0.8 } }],
    plan: (doc, a) => {
      const ops: Op[] = [];
      for (const id of a.clips) {
        const { clip: c } = clipRef(doc, id, { unlocked: true });
        const t = { ...c.transform };
        if (a.x != null) t.x = still(a.x);
        if (a.y != null) t.y = still(a.y);
        if (a.scale != null) t.scale = still(a.scale);
        if (a.rotation != null) t.rotation = still(a.rotation);
        if (a.opacity != null) t.opacity = still(a.opacity);
        if (a.crop) {
          t.crop = { ...t.crop, ...a.crop };
          if (t.crop.left + t.crop.right >= 0.98 || t.crop.top + t.crop.bottom >= 0.98) throw new AgentError('RANGE', 'Crop would leave nothing visible.', 'Opposite sides must add up to less than 0.98.');
        }
        if (a.flipH != null) t.flipH = a.flipH;
        if (a.flipV != null) t.flipV = a.flipV;
        const patch: Partial<Clip> = {};
        if (JSON.stringify(t) !== JSON.stringify(c.transform)) patch.transform = t;
        if (a.fit) patch.fit = a.fit;
        if (a.blend) patch.blend = a.blend;
        if (a.reverse != null) { if (c.kind !== 'media') throw new AgentError('NOT_MEDIA', 'Only media clips can be reversed.', undefined); patch.reverse = a.reverse; }
        if (a.enabled != null) patch.enabled = a.enabled;
        if (a.name != null) patch.name = a.name;
        if (a.color != null) patch.color = a.color;
        if (Object.keys(patch).length) ops.push({ op: 'updateClip', id, patch });
      }
      return { ops, summary: `Set properties on ${a.clips.length} clip(s)` };
    },
  }),

  defineEdit({
    name: 'set_keyframes', title: 'Animate a property', group: 'clip', idempotent: true,
    description: 'Animate a clip property with keyframes: x, y (pixels from center), scale, rotation (degrees), opacity (0-1), volume (dB) or an effect parameter (property:"effect" with effect id and param, e.g. a color exposure ramp). Keyframe times are timeline seconds unless timeBase is "clip". Values between keyframes follow each keyframe\'s ease (linear, ease, easeIn, easeOut, hold). An empty keyframes list removes the animation and keeps the first value.',
    input: {
      clip: Ref, property: z.enum(KEYFRAME_PROPERTIES),
      effect: z.string().max(64).optional().describe('For property "effect": the effect id (from get_clip) or type'),
      param: z.string().max(64).optional().describe('For property "effect": the parameter, e.g. exposure, amount, radius'),
      keyframes: z.array(KeyframeIn).max(500),
      timeBase: z.enum(['timeline', 'clip']).optional(),
    },
    examples: [
      { args: { clip: 'clip_abc', property: 'scale', keyframes: [{ time: 2, value: 1 }, { time: 4, value: 1.3, ease: 'easeOut' }] }, note: 'Slow push-in' },
      { args: { clip: 'clip_title', property: 'y', timeBase: 'clip', keyframes: [{ time: 0, value: 300 }, { time: 0.4, value: 0 }] } },
      { args: { clip: 'clip_music', property: 'volume', keyframes: [{ time: 10, value: -6 }, { time: 12, value: -30 }] }, note: 'Dip the music' },
    ],
    plan: (doc, a) => {
      const { clip: c } = clipRef(doc, a.clip, { unlocked: true });
      const base = a.timeBase ?? 'timeline';
      const make = (cur: Animatable) => (a.keyframes.length ? toKeyframes(c, a.keyframes, base) : { value: cur.keyframes?.[0]?.v ?? cur.value });
      let patch: Partial<Clip>;
      if (a.property === 'volume') {
        if (!c.audio) throw new AgentError('NO_AUDIO', `Clip ${c.id} has no audio.`, undefined);
        patch = { audio: { ...c.audio, gainDb: make(c.audio.gainDb) } };
      } else if (a.property === 'effect') {
        if (!a.effect || !a.param) throw new AgentError('INVALID_ARGS', 'property "effect" needs `effect` (id or type) and `param`.', 'get_clip lists effect ids and params.');
        const fx = c.effects.find((e) => e.id === a.effect) ?? c.effects.find((e) => e.type === a.effect);
        if (!fx) throw new AgentError('EFFECT_NOT_FOUND', `Clip ${c.id} has no effect "${a.effect}".`, 'add_effect first, or read ids with get_clip.');
        const cur = fx.params[a.param];
        const curAnim: Animatable = typeof cur === 'object' && cur ? cur : { value: typeof cur === 'number' ? cur : 0 };
        patch = { effects: c.effects.map((e) => (e.id === fx.id ? { ...e, params: { ...e.params, [a.param!]: make(curAnim) } } : e)) };
      } else {
        const key = a.property as 'x' | 'y' | 'scale' | 'rotation' | 'opacity';
        patch = { transform: { ...c.transform, [key]: make(c.transform[key]) } };
      }
      return { ops: [{ op: 'updateClip', id: c.id, patch }], summary: a.keyframes.length ? `Animate ${a.property}${a.param ? `.${a.param}` : ''} (${a.keyframes.length} keyframes)` : `Remove ${a.property} animation` };
    },
  }),

  defineEdit({
    name: 'set_speed', title: 'Change speed', group: 'clip',
    description: 'Change a media clip\'s playback speed. Give `rate` (0.05 to 20; 2 = twice as fast) for a constant speed, `ramp` for a preset speed ramp (montage, hero, bullet, ease-in, ease-out), or `points` for a custom ramp over the clip (at 0 to 1 of its length). ripple:true (default) moves later clips on the lane to follow the new length. preservePitch keeps voices natural (constant speed only).',
    input: {
      clip: Ref, rate: z.number().min(0.05).max(20).optional(), ramp: z.enum(Object.keys(RAMP_PRESETS) as [string, ...string[]]).optional(),
      points: z.array(z.object({ at: z.number().min(0).max(1), rate: z.number().min(0.05).max(20) })).min(2).max(50).optional(),
      preservePitch: z.boolean().optional(), ripple: z.boolean().optional(),
    },
    examples: [{ args: { clip: 'clip_abc', rate: 1.25 } }, { args: { clip: 'clip_broll', ramp: 'hero' } }, { args: { clip: 'clip_broll', points: [{ at: 0, rate: 1 }, { at: 0.5, rate: 4 }, { at: 1, rate: 1 }] } }],
    plan: (doc, a) => {
      const { clip: c, lane } = clipRef(doc, a.clip, { unlocked: true });
      if (c.kind !== 'media') throw new AgentError('NOT_MEDIA', 'Only media clips have a speed.', undefined);
      const given = [a.rate, a.ramp, a.points].filter((x) => x != null).length;
      if (given !== 1) throw new AgentError('INVALID_ARGS', 'Give exactly one of rate, ramp or points.', 'For example {"clip":"...","rate":1.5}.');
      const ripple = a.ripple ?? true;
      if (a.rate != null) {
        const tx = new Tx(doc);
        for (const op of setSpeedOps(tx.doc, c.id, a.rate, ripple)) tx.do(op);
        if (a.preservePitch != null) tx.do({ op: 'updateClip', id: c.id, patch: { speed: { kind: 'constant', rate: a.rate, preservePitch: a.preservePitch } } });
        return { ops: tx.ops, summary: `Speed ${a.rate}x` };
      }
      if (a.ramp) return { ops: setRampOps(doc, c.id, a.ramp, ripple), summary: `Speed ramp: ${RAMP_PRESETS[a.ramp]!.label}` };
      const pts = [...a.points!].sort((x, y) => x.at - y.at);
      if (pts[0]!.at !== 0 || pts[pts.length - 1]!.at !== 1) throw new AgentError('RANGE', 'Ramp points must start at 0 and end at 1.', undefined);
      const speed: Speed = { kind: 'ramp', points: pts, preservePitch: false };
      const tx = new Tx(doc);
      const before = clipEnd(c);
      tx.do({ op: 'updateClip', id: c.id, patch: { speed } });
      const after = clipEnd(tx.doc.lanes.find((l) => l.id === lane.id)!.clips.find((x) => x.id === c.id)!);
      if (ripple && after !== before) for (const o of tx.doc.lanes.find((l) => l.id === lane.id)!.clips.filter((x) => x.start >= before && x.id !== c.id)) tx.do({ op: 'updateClip', id: o.id, patch: { start: Math.max(0, o.start + after - before) } });
      return { ops: tx.ops, summary: 'Custom speed ramp' };
    },
  }),

  defineEdit({
    name: 'freeze_frame', title: 'Freeze frame', group: 'clip',
    description: 'Hold the frame of a video clip at `at` (timeline seconds) for `duration` seconds (default 1). Everything after moves later to make room.',
    input: { clip: Ref, at: Seconds, duration: z.number().min(0.04).max(60).optional() },
    examples: [{ args: { clip: 'clip_abc', at: 3.5, duration: 1.5 } }],
    plan: (doc, a) => {
      const { clip } = clipRef(doc, a.clip, { unlocked: true });
      const t = frameUs(doc, a.at);
      insideClip(clip, t, 'freeze point');
      const ops = freezeFrameOps(doc, clip.id, t, us(a.duration ?? 1));
      const added = ops.filter((o): o is Extract<Op, { op: 'addClip' }> => o.op === 'addClip').map((o) => o.clip.id);
      return { ops, summary: `Freeze frame at ${sec(t)} s`, result: { createdClips: added } };
    },
  }),

  defineEdit({
    name: 'detach_audio', title: 'Detach audio', group: 'clip',
    description: 'Split the sound of a video clip onto an audio lane (default voice) as a separate, linked clip, and mute the video clip\'s own sound. Use it to J/L-cut, clean up or mix the voice separately.',
    input: { clip: Ref, lane: LaneRef.optional() },
    examples: [{ args: { clip: 'clip_camera' } }],
    plan: (doc, a) => {
      const { clip } = clipRef(doc, a.clip, { unlocked: true });
      if (!clip.audio || clip.audio.muted) throw new AgentError('NO_AUDIO', `Clip ${clip.id} has no audible sound to detach.`, undefined);
      const lane = laneRef(doc, a.lane ?? 'voice', { unlocked: true });
      const ops = detachAudioOps(doc, clip.id, lane.id);
      const added = ops.find((o): o is Extract<Op, { op: 'addClip' }> => o.op === 'addClip')!;
      return { ops, summary: 'Detach audio', result: { audioClip: added.clip.id, lane: lane.id } };
    },
  }),

  defineEdit({
    name: 'set_layout', title: 'Picture-in-picture layout', group: 'clip', idempotent: true,
    description: 'Place a visual clip in a preset layout: full, top-left, top-right, bottom-left, bottom-right (small corner picture-in-picture), split-top or split-bottom (half the frame each, for reaction or screen-plus-face shots). Put the overlay on a lane above the main shot.',
    input: { clip: Ref, layout: z.enum(LAYOUTS) },
    examples: [{ args: { clip: 'clip_face', layout: 'bottom-right' } }, { args: { clip: 'clip_screen', layout: 'split-top' } }],
    plan: (doc, a) => {
      const { clip } = clipRef(doc, a.clip, { unlocked: true });
      if (clip.kind !== 'media') throw new AgentError('NOT_MEDIA', 'Layouts apply to video or image clips.', 'Use set_clip x/y/scale for text and shapes.');
      return { ops: pipOps(doc, clip.id, a.layout as PipLayout), summary: `Layout: ${a.layout}` };
    },
  }),
];
