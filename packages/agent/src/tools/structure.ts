import { z } from 'zod';
import {
  AUDIO_LANES, CANVAS_PRESETS, COMMON_FPS, applyTemplateOps, clipDuration, defaultAudio, newLane, uid,
  type Canvas, type Clip, type Op, type Project,
} from '@director/engine';
import { AgentError, defineEdit } from '../core';
import { Color, LANE_KINDS, LaneRef, Ref, Seconds, clipRef, frameUs, inTimeline, laneRef, sec, us } from '../units';

const MARKER_KINDS = ['note', 'retake', 'cue', 'chapter', 'beat', 'good', 'bad'] as const;

export const audioTools = [
  defineEdit({
    name: 'set_audio', title: 'Mix a clip\'s audio', group: 'audio', idempotent: true,
    description: 'Set audio on clips: volume in dB (0 = unchanged, -6 = half as loud, +6 louder; range -60 to +24), pan (-1 left to 1 right), fadeIn/fadeOut in seconds, muted, and duckUnderVoice (music dips automatically wherever someone speaks). Animate volume over time with set_keyframes property "volume".',
    input: { clips: z.array(Ref).min(1).max(500), volume: z.number().min(-60).max(24).optional(), pan: z.number().min(-1).max(1).optional(), fadeIn: z.number().min(0).max(60).optional(), fadeOut: z.number().min(0).max(60).optional(), muted: z.boolean().optional(), duckUnderVoice: z.boolean().optional() },
    examples: [{ args: { clips: ['clip_music'], volume: -14, duckUnderVoice: true, fadeIn: 1, fadeOut: 2.5 }, note: 'Music bed under a voiceover' }, { args: { clips: ['clip_camera'], muted: true } }],
    plan: (doc, a) => {
      const ops: Op[] = a.clips.map((id) => {
        const { clip, lane } = clipRef(doc, id, { unlocked: true });
        const m = clip.mediaId ? doc.media[clip.mediaId] : undefined;
        if (!m?.hasAudio) throw new AgentError('NO_AUDIO', `Clip ${id} has no sound.`, 'Only clips of media with audio can be mixed.');
        const cur = clip.audio ?? defaultAudio();
        const dur = clipDuration(clip);
        for (const [k, v] of [['fadeIn', a.fadeIn], ['fadeOut', a.fadeOut]] as const) if (v != null && us(v) > dur) throw new AgentError('RANGE', `${k} ${v} s is longer than the clip (${sec(dur)} s).`, undefined);
        if (a.duckUnderVoice && !AUDIO_LANES.has(lane.kind)) throw new AgentError('NOT_SUPPORTED', 'Ducking applies to clips on the music or sfx lanes.', 'Move or add the music to the music lane.');
        const audio = {
          ...cur,
          ...(a.volume != null ? { gainDb: { value: a.volume } } : {}),
          ...(a.pan != null ? { pan: a.pan } : {}),
          ...(a.fadeIn != null ? { fadeIn: us(a.fadeIn) } : {}),
          ...(a.fadeOut != null ? { fadeOut: us(a.fadeOut) } : {}),
          ...(a.muted != null ? { muted: a.muted } : {}),
          ...(a.duckUnderVoice != null ? { duckable: a.duckUnderVoice } : {}),
        };
        return { op: 'updateClip' as const, id, patch: { audio } };
      });
      return { ops, summary: `Audio on ${a.clips.length} clip(s)` };
    },
  }),
];

export const structureTools = [
  defineEdit({
    name: 'add_lane', title: 'Add a lane', group: 'structure',
    description: `Add a lane (track). Kinds: ${LANE_KINDS.join(', ')}. Lanes higher in the list draw on top. Default position: with the other lanes of its kind.`,
    input: { kind: z.enum(LANE_KINDS), name: z.string().min(1).max(100).optional(), index: z.number().int().min(0).max(100).optional() },
    examples: [{ args: { kind: 'broll', name: 'B-roll 2' } }],
    plan: (doc, a) => {
      const lane = newLane(a.kind, a.name ? { name: a.name } : {});
      const last = doc.lanes.map((l) => l.kind).lastIndexOf(a.kind);
      const index = a.index ?? (last >= 0 ? last : doc.lanes.length);
      return { ops: [{ op: 'addLane', lane, index }], summary: `Add ${a.kind} lane`, result: { lane: lane.id, index } };
    },
  }),
  defineEdit({
    name: 'update_lane', title: 'Lane settings', group: 'structure', idempotent: true,
    description: 'Rename a lane, mute or solo its sound, hide its picture, or lock it against edits.',
    input: { lane: LaneRef, name: z.string().min(1).max(100).optional(), muted: z.boolean().optional(), solo: z.boolean().optional(), hidden: z.boolean().optional(), locked: z.boolean().optional() },
    examples: [{ args: { lane: 'music', muted: true } }, { args: { lane: 'camera', locked: true } }],
    plan: (doc, a) => {
      const lane = laneRef(doc, a.lane);
      const patch: Record<string, unknown> = {};
      for (const k of ['name', 'muted', 'solo', 'hidden', 'locked'] as const) if (a[k] !== undefined) patch[k] = a[k];
      return { ops: Object.keys(patch).length ? [{ op: 'updateLane', id: lane.id, patch }] : [], summary: `Lane ${lane.name}: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ')}` };
    },
  }),
  defineEdit({
    name: 'remove_lane', title: 'Remove a lane', group: 'structure', destructive: true,
    description: 'Remove a lane. A lane with clips is only removed with force:true (its clips go too; undoable).',
    input: { lane: LaneRef, force: z.boolean().optional() },
    examples: [{ args: { lane: 'lane_123' } }],
    plan: (doc, a) => {
      const lane = laneRef(doc, a.lane, { unlocked: true });
      if (lane.clips.length && !a.force) throw new AgentError('NOT_EMPTY', `Lane ${lane.id} has ${lane.clips.length} clip(s).`, 'Pass force:true to remove it with its clips, or move them first.');
      return { ops: [{ op: 'removeLane', id: lane.id }], summary: `Remove lane ${lane.name}` };
    },
  }),
  defineEdit({
    name: 'move_lane', title: 'Reorder a lane', group: 'structure',
    description: 'Move a lane to position `index` (0 is the top, drawn over everything below).',
    input: { lane: LaneRef, index: z.number().int().min(0).max(100) },
    examples: [{ args: { lane: 'titles', index: 0 } }],
    plan: (doc, a) => { const lane = laneRef(doc, a.lane); return { ops: [{ op: 'moveLane', id: lane.id, index: a.index }], summary: `Move lane ${lane.name} to ${a.index}` }; },
  }),

  defineEdit({
    name: 'add_marker', title: 'Add a marker', group: 'structure',
    description: `Drop a marker at a timeline time with a label, for notes, chapters or beats. Kinds: ${MARKER_KINDS.join(', ')}. Optional duration in seconds marks a range.`,
    input: { at: Seconds, label: z.string().min(1).max(400), kind: z.enum(MARKER_KINDS).optional(), duration: z.number().min(0).max(36_000).optional(), color: Color.optional() },
    examples: [{ args: { at: 12.4, label: 'Hook ends', kind: 'chapter' } }],
    plan: (doc, a) => {
      const t = frameUs(doc, a.at);
      inTimeline(doc, t, 'Marker time');
      const marker = { id: uid('mk'), t, kind: a.kind ?? 'note' as const, label: a.label, ...(a.duration ? { duration: us(a.duration) } : {}), ...(a.color ? { color: a.color } : {}) };
      return { ops: [{ op: 'addMarker', marker }], summary: `Marker "${a.label}" at ${sec(t)} s`, result: { marker: marker.id } };
    },
  }),
  defineEdit({
    name: 'update_marker', title: 'Change a marker', group: 'structure', idempotent: true,
    description: 'Move a marker (at, timeline seconds) or change its label, kind, duration (seconds) or color.',
    input: { marker: Ref, at: Seconds.optional(), label: z.string().min(1).max(400).optional(), kind: z.enum(MARKER_KINDS).optional(), duration: z.number().min(0).max(36_000).optional(), color: Color.optional() },
    examples: [{ args: { marker: 'mk_123', label: 'CTA', at: 25 } }],
    plan: (doc, a) => {
      if (!doc.markers.some((m) => m.id === a.marker)) throw new AgentError('MARKER_NOT_FOUND', `No marker "${a.marker}".`, 'get_timeline lists markers with their ids.');
      const patch: Record<string, unknown> = {};
      if (a.at != null) patch.t = frameUs(doc, a.at);
      for (const k of ['label', 'kind', 'color'] as const) if (a[k] !== undefined) patch[k] = a[k];
      if (a.duration != null) patch.duration = us(a.duration);
      return { ops: [{ op: 'updateMarker', id: a.marker, patch }], summary: 'Update marker' };
    },
  }),
  defineEdit({
    name: 'remove_marker', title: 'Remove markers', group: 'structure', destructive: true,
    description: 'Remove markers by id, or every marker of a kind (for example all "beat" markers).',
    input: { markers: z.array(Ref).max(1000).optional(), kind: z.enum(MARKER_KINDS).optional() },
    examples: [{ args: { markers: ['mk_123'] } }, { args: { kind: 'beat' } }],
    plan: (doc, a) => {
      const ids = a.markers ?? (a.kind ? doc.markers.filter((m) => m.kind === a.kind).map((m) => m.id) : null);
      if (!ids) throw new AgentError('INVALID_ARGS', 'Give markers (ids) or kind.', undefined);
      for (const id of ids) if (!doc.markers.some((m) => m.id === id)) throw new AgentError('MARKER_NOT_FOUND', `No marker "${id}".`, 'get_timeline lists markers.');
      return { ops: ids.map((id) => ({ op: 'removeMarker' as const, id })), summary: `Remove ${ids.length} marker(s)` };
    },
  }),

  defineEdit({
    name: 'set_canvas', title: 'Frame size, frame rate and background', group: 'structure', idempotent: true,
    description: `Change the project frame: preset (${Object.keys(CANVAS_PRESETS).join(', ')}) or width/height in pixels, fps (${Object.keys(COMMON_FPS).join(', ')}), and the background behind everything: a color, or blur (a blurred, zoomed copy of the video fills the empty space, for landscape footage in a vertical frame).`,
    input: { preset: z.enum(Object.keys(CANVAS_PRESETS) as [string, ...string[]]).optional(), width: z.number().int().min(16).max(8192).optional(), height: z.number().int().min(16).max(8192).optional(), fps: z.enum(Object.keys(COMMON_FPS) as [string, ...string[]]).optional(), background: z.union([Color, z.literal('blur')]).optional(), blurAmount: z.number().min(0).max(1).optional() },
    examples: [{ args: { preset: 'vertical-1080', fps: '30' } }, { args: { background: 'blur', blurAmount: 0.6 } }],
    plan: (doc, a) => {
      const patch: Partial<Canvas> = {};
      if (a.preset) Object.assign(patch, CANVAS_PRESETS[a.preset]);
      if (a.width) patch.width = a.width;
      if (a.height) patch.height = a.height;
      if (patch.width && patch.width % 2) throw new AgentError('RANGE', 'Width must be even (video encoders need it).', undefined);
      if (patch.height && patch.height % 2) throw new AgentError('RANGE', 'Height must be even (video encoders need it).', undefined);
      if (a.fps) patch.fps = COMMON_FPS[a.fps]!;
      if (a.background) patch.background = a.background === 'blur' ? { kind: 'blur', amount: a.blurAmount ?? 0.5 } : { kind: 'color', color: a.background };
      return { ops: Object.keys(patch).length ? [{ op: 'setCanvas', patch }] : [], summary: `Canvas ${patch.width ?? doc.canvas.width}x${patch.height ?? doc.canvas.height}` };
    },
  }),
  defineEdit({
    name: 'set_project', title: 'Project name and settings', group: 'structure', idempotent: true,
    description: 'Rename the project or change its settings: snapping, ripple by default (what the person\'s own edits do), and the platform safe zone captions avoid (reels, tiktok, shorts, none).',
    input: { name: z.string().min(1).max(200).optional(), snapping: z.boolean().optional(), rippleByDefault: z.boolean().optional(), safeZone: z.enum(['none', 'reels', 'tiktok', 'shorts']).optional() },
    examples: [{ args: { name: 'Prompting reel v2', safeZone: 'tiktok' } }],
    plan: (doc, a) => {
      const ops: Op[] = [];
      if (a.name) ops.push({ op: 'setMeta', patch: { name: a.name } });
      const s = { ...doc.settings };
      if (a.snapping != null) s.snapping = a.snapping;
      if (a.rippleByDefault != null) s.rippleByDefault = a.rippleByDefault;
      if (a.safeZone) s.safeZone = a.safeZone;
      if (JSON.stringify(s) !== JSON.stringify(doc.settings)) ops.push({ op: 'setMeta', patch: { settings: s } });
      return { ops, summary: 'Project settings' };
    },
  }),

  defineEdit({
    name: 'apply_template', title: 'Apply a saved template', group: 'structure',
    description: 'Place a saved template (a group of titles, shapes and graphics saved from the Text panel or save_template) at `at` seconds, filling its text slots in order with `texts`. list_templates shows what exists.',
    input: { template: z.string().min(1).max(200).describe('Template id or name'), at: Seconds, texts: z.array(z.string().max(5000)).max(50).optional() },
    examples: [{ args: { template: 'Lower third', at: 3, texts: ['Sam Rivera', 'Founder'] } }],
    plan: (doc, a, env) => {
      const t = env.templates?.find((x) => x.id === a.template || x.name === a.template);
      if (!t) throw new AgentError('TEMPLATE_NOT_FOUND', `No template "${a.template}".`, 'list_templates shows saved templates; save_template makes one from clips.');
      const ops = applyTemplateOps(doc, t, frameUs(doc, a.at), a.texts ?? []);
      return { ops, summary: `Apply template ${t.name}`, result: { clips: ops.filter((o): o is Extract<Op, { op: 'addClip' }> => o.op === 'addClip').map((o) => o.clip.id) } };
    },
  }),
];

export function isProject(x: unknown): x is Project { return !!x && typeof x === 'object' && 'lanes' in (x as object); }
export type { Clip };
