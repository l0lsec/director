import { z } from 'zod';
import { EFFECT_DEFS, TRANSITIONS, clipDuration, effectDefaults, uid, type Clip, type Effect, type Op } from '@director/engine';
import { AgentError, defineEdit } from '../core';
import { Ref, clipRef, us } from '../units';

const ADDABLE = Object.values(EFFECT_DEFS).filter((d) => d.addable).map((d) => d.type) as [string, ...string[]];
const ParamValue = z.union([z.number(), z.string().max(4096), z.boolean()]);

/** Validate and convert agent params (seconds, ranges, extras) to storage values. */
function convertParams(type: string, params: Record<string, number | string | boolean>, clip: Clip, env: { fileExists?: (p: string) => boolean }): Effect['params'] {
  const def = EFFECT_DEFS[type]!;
  const out: Effect['params'] = {};
  for (const [k, v] of Object.entries(params)) {
    const p = def.params.find((x) => x.key === k);
    const x = def.extras?.find((e) => e.key === k);
    if (!p && !x) throw new AgentError('UNKNOWN_PARAM', `The ${type} effect has no parameter "${k}". It has: ${[...def.params.map((q) => q.key), ...(def.extras ?? []).map((e) => e.key)].join(', ')}.`, 'get_capabilities {"topic":"effects"} lists every parameter with its range and unit.');
    if (p) {
      if (typeof v !== 'number') throw new AgentError('INVALID_ARGS', `${type}.${k} must be a number.`, undefined);
      if (v < p.min || v > p.max) throw new AgentError('OUT_OF_RANGE', `${type}.${k} = ${v} is outside ${p.min} to ${p.max}${p.unit ? ` (${p.unit})` : ''}.`, `${p.description}.`);
      if (p.unit === 's' && v > clipDuration(clip) / 1e6 + 0.001) throw new AgentError('OUTSIDE_CLIP', `${type}.${k} = ${v} s is past the end of the clip (${(clipDuration(clip) / 1e6).toFixed(3)} s long; ${k} counts from the clip start).`, undefined);
      out[k] = p.unit === 's' ? us(v) : v;
    } else if (x) {
      if (x.kind === 'enum' && !x.values!.includes(String(v))) throw new AgentError('OUT_OF_RANGE', `${type}.${k} must be one of ${x.values!.join(', ')}.`, undefined);
      if (x.kind === 'boolean' && typeof v !== 'boolean') throw new AgentError('INVALID_ARGS', `${type}.${k} must be true or false.`, undefined);
      if (x.kind === 'color' && !/^#[0-9a-f]{6}$/i.test(String(v))) throw new AgentError('INVALID_ARGS', `${type}.${k} must be a color like #00ff00.`, undefined);
      if (x.kind === 'path') {
        const s = String(v);
        if (!s.startsWith('/') || (type === 'lut' && !/\.cube$/i.test(s))) throw new AgentError('INVALID_ARGS', `${type}.${k} must be an absolute path${type === 'lut' ? ' to a .cube file' : ''}.`, undefined);
        if (env.fileExists && !env.fileExists(s)) throw new AgentError('FILE_NOT_FOUND', `No file at ${s}.`, 'Give the absolute path of an existing .cube file.');
      }
      out[k] = v;
    }
  }
  return out;
}

function findEffect(c: Clip, ref: string): Effect {
  const fx = c.effects.find((e) => e.id === ref) ?? c.effects.find((e) => e.type === ref);
  if (!fx) throw new AgentError('EFFECT_NOT_FOUND', `Clip ${c.id} has no effect "${ref}"${c.effects.length ? ` (it has ${c.effects.map((e) => `${e.id} ${e.type}`).join(', ')})` : ''}.`, 'add_effect adds one; get_clip lists effect ids.');
  return fx;
}

export const effectTools = [
  defineEdit({
    name: 'add_effect', title: 'Add an effect', group: 'effects',
    description: `Add an effect to one or more clips: ${ADDABLE.join(', ')}. Parameters you leave out take their defaults. Time parameters (zoom at/ramp/until) are seconds from the clip start. lut needs params.path (absolute path to a .cube file). get_capabilities {"topic":"effects"} lists every parameter with range and unit. Returns the new effect ids per clip.`,
    input: {
      clips: z.array(Ref).min(1).max(200),
      type: z.enum(ADDABLE),
      params: z.record(z.string().max(64), ParamValue).optional(),
    },
    examples: [
      { args: { clips: ['clip_abc'], type: 'color', params: { exposure: 0.2, contrast: 0.15, saturation: 0.1, temperature: 0.1 } }, note: 'Warm, punchy grade' },
      { args: { clips: ['clip_abc'], type: 'zoom', params: { at: 2.4, amount: 1.2, ramp: 0.15, until: 4 } }, note: 'Punch in at 2.4 s into the clip, release at 4 s' },
      { args: { clips: ['clip_abc'], type: 'vignette', params: { amount: 0.35 } } },
    ],
    plan: (doc, a, env) => {
      const ops: Op[] = [];
      const created: Record<string, string> = {};
      for (const id of a.clips) {
        const { clip } = clipRef(doc, id, { unlocked: true });
        if (clip.kind === 'caption' && a.type !== 'color') throw new AgentError('NOT_SUPPORTED', 'Captions only take color effects; restyle them with style_captions.', undefined);
        if (a.type === 'lut' && typeof a.params?.path !== 'string') throw new AgentError('INVALID_ARGS', 'lut needs params.path, the absolute path to a .cube file.', undefined);
        const fx: Effect = { id: uid('fx'), type: a.type, enabled: true, params: { ...effectDefaults(a.type), ...convertParams(a.type, a.params ?? {}, clip, env) } };
        created[id] = fx.id;
        ops.push({ op: 'updateClip', id, patch: { effects: [...clip.effects, fx] } });
      }
      return { ops, summary: `Add ${EFFECT_DEFS[a.type]!.label} to ${a.clips.length} clip(s)`, result: { effects: created } };
    },
  }),

  defineEdit({
    name: 'update_effect', title: 'Change an effect', group: 'effects', idempotent: true,
    description: 'Change parameters of an effect on a clip (by effect id, or by type for the first of that type), switch it on or off with enabled, or move it in the stack with index (effects apply top to bottom). Setting a parameter replaces any keyframes on it.',
    input: { clip: Ref, effect: z.string().min(1).max(64).describe('Effect id from get_clip, or its type'), params: z.record(z.string().max(64), ParamValue).optional(), enabled: z.boolean().optional(), index: z.number().int().min(0).max(50).optional() },
    examples: [{ args: { clip: 'clip_abc', effect: 'color', params: { saturation: -1 } }, note: 'Black and white' }, { args: { clip: 'clip_abc', effect: 'fx_123', enabled: false } }],
    plan: (doc, a, env) => {
      const { clip } = clipRef(doc, a.clip, { unlocked: true });
      const fx = findEffect(clip, a.effect);
      const next: Effect = { ...fx, enabled: a.enabled ?? fx.enabled, params: { ...fx.params, ...convertParams(fx.type, a.params ?? {}, clip, env) } };
      let effects = clip.effects.map((e) => (e.id === fx.id ? next : e));
      if (a.index != null) { effects = effects.filter((e) => e.id !== fx.id); effects.splice(Math.min(a.index, effects.length), 0, next); }
      return { ops: [{ op: 'updateClip', id: clip.id, patch: { effects } }], summary: `Update ${EFFECT_DEFS[fx.type]?.label ?? fx.type}` };
    },
  }),

  defineEdit({
    name: 'remove_effect', title: 'Remove an effect', group: 'effects', destructive: true,
    description: 'Remove one effect from a clip (by id, or by type for the first of that type), or all of them with effect:"all".',
    input: { clip: Ref, effect: z.string().min(1).max(64) },
    examples: [{ args: { clip: 'clip_abc', effect: 'fx_123' } }, { args: { clip: 'clip_abc', effect: 'all' } }],
    plan: (doc, a) => {
      const { clip } = clipRef(doc, a.clip, { unlocked: true });
      if (a.effect === 'all') return { ops: clip.effects.length ? [{ op: 'updateClip', id: clip.id, patch: { effects: [] } }] : [], summary: `Remove all effects from ${clip.id}` };
      const fx = findEffect(clip, a.effect);
      return { ops: [{ op: 'updateClip', id: clip.id, patch: { effects: clip.effects.filter((e) => e.id !== fx.id) } }], summary: `Remove ${EFFECT_DEFS[fx.type]?.label ?? fx.type}` };
    },
  }),

  defineEdit({
    name: 'copy_effects', title: 'Copy a look to other clips', group: 'effects',
    description: 'Paste the effects of one clip (its whole look: grade, LUT, vignette and so on) onto other clips, replacing or adding to theirs. Time-based effects (zoom) are skipped unless includeTimed is true.',
    input: { from: Ref, to: z.array(Ref).min(1).max(200), mode: z.enum(['replace', 'append']).optional(), includeTimed: z.boolean().optional() },
    examples: [{ args: { from: 'clip_graded', to: ['clip_b', 'clip_c'] } }],
    plan: (doc, a) => {
      const { clip: src } = clipRef(doc, a.from);
      const look = src.effects.filter((e) => a.includeTimed || e.type !== 'zoom').filter((e) => e.type !== 'matte');
      if (!look.length) throw new AgentError('NOTHING_THERE', `Clip ${src.id} has no effects to copy.`, undefined);
      const ops: Op[] = a.to.map((id) => {
        const { clip } = clipRef(doc, id, { unlocked: true });
        const copies = look.map((e) => ({ ...structuredClone(e), id: uid('fx') }));
        return { op: 'updateClip' as const, id, patch: { effects: (a.mode ?? 'replace') === 'replace' ? [...clip.effects.filter((e) => e.type === 'matte'), ...copies] : [...clip.effects, ...copies] } };
      });
      return { ops, summary: `Copy ${look.length} effect(s) to ${a.to.length} clip(s)` };
    },
  }),

  defineEdit({
    name: 'set_transition', title: 'Set a transition', group: 'effects', idempotent: true,
    description: `Set the transition into a clip from the clip before it on the same lane: ${TRANSITIONS.map((t) => t.id).join(', ')}. duration in seconds (default 0.4). type:"none" removes it. A clip that starts a lane fades in from black (dip-black) or from what is below.`,
    input: { clips: z.array(Ref).min(1).max(200), type: z.enum(['none', ...TRANSITIONS.map((t) => t.id)] as [string, ...string[]]), duration: z.number().min(0.04).max(5).optional() },
    examples: [{ args: { clips: ['clip_b'], type: 'crossfade', duration: 0.3 } }, { args: { clips: ['clip_b', 'clip_c'], type: 'whip', duration: 0.25 } }],
    plan: (doc, a) => {
      const ops: Op[] = a.clips.map((id) => {
        const { clip } = clipRef(doc, id, { unlocked: true });
        if (a.type === 'none') return { op: 'updateClip' as const, id, patch: {}, unset: ['transitionIn'] };
        const d = us(a.duration ?? 0.4);
        if (d >= clipDuration(clip)) throw new AgentError('RANGE', `A ${a.duration} s transition is longer than clip ${id} (${clipDuration(clip) / 1e6} s).`, 'Use a shorter duration.');
        return { op: 'updateClip' as const, id, patch: { transitionIn: { type: a.type, duration: d } } };
      });
      return { ops, summary: a.type === 'none' ? 'Remove transition' : `Transition: ${a.type}` };
    },
  }),
];
