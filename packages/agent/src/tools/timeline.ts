import { z } from 'zod';
import {
  AUDIO_LANES, Tx, clipDuration, clipEnd, defaultAudio, deleteClipsOps, duplicateClipOps, findClip, insertClipOps,
  liftRangeOps, mergeRanges, moveClipOps, newClip, rippleDeleteRangeOps, rippleDeleteRangesOps, rollOps, slipOps, splitOps,
  timelineDuration, trimOps, uid, laneOfKind, type LaneKind, type MediaRef, type Op, type Project,
} from '@director/engine';
import { AgentError, defineEdit } from '../core';
import { LaneRef, Ref, Seconds, SecondsDelta, clipRef, frameUs, insideClip, laneRef, mediaRef, sec, us } from '../units';

export function laneKindForMedia(m: MediaRef, doc: Project): LaneKind {
  if (m.role === 'camera') return 'camera';
  if (m.role === 'screen') return 'screen';
  if (m.kind === 'audio') return m.role === 'sfx' ? 'sfx' : m.role === 'mic' ? 'voice' : 'music';
  if (m.kind === 'video' && m.role !== 'broll' && !laneOfKind(doc, 'camera')?.clips.length) return 'camera';
  return 'broll';
}

const ids = (xs: string[]) => xs.join(', ');

export const timelineTools = [
  defineEdit({
    name: 'add_clip', title: 'Place media on the timeline', group: 'timeline',
    description: 'Put an imported media item (from list_media) on a lane. Times in seconds. sourceIn/sourceOut pick the part of the file to use (default: all of it; images default to 3 s, or set duration). By default the clip overwrites whatever is under it on its lane; insert:true pushes everything after it later instead (ripple insert). Lane defaults to the natural lane for the media (camera, screen, broll, voice, music or sfx).',
    input: {
      media: Ref.describe('Media id (or exact name) from list_media'),
      lane: LaneRef.optional(),
      start: Seconds.optional().describe('Timeline position in seconds (default: end of the lane)'),
      sourceIn: Seconds.optional().describe('Seconds into the file where the clip starts (default 0)'),
      sourceOut: Seconds.optional().describe('Seconds into the file where the clip ends (default: end of file)'),
      duration: z.number().positive().max(36_000).optional().describe('Length in seconds (images and when sourceOut is not given)'),
      insert: z.boolean().optional().describe('Ripple insert: push later clips on all lanes to make room (default false: overwrite)'),
      name: z.string().max(200).optional(),
      fit: z.enum(['cover', 'contain', 'stretch']).optional().describe('How it fills the frame (default cover; screen recordings default contain)'),
    },
    examples: [{ args: { media: 'media_1', lane: 'broll', start: 4.5, sourceIn: 10, sourceOut: 13 }, note: '3 s of b-roll at 4.5 s' }, { args: { media: 'media_2', insert: true, start: 0 } }],
    plan: (doc, a) => {
      const m = mediaRef(doc, a.media);
      const lane = a.lane ? laneRef(doc, a.lane, { unlocked: true }) : laneRef(doc, laneKindForMedia(m, doc), { unlocked: true });
      if (AUDIO_LANES.has(lane.kind) && !m.hasAudio) throw new AgentError('NO_AUDIO', `${m.name} has no audio, so it cannot go on the ${lane.kind} lane.`, 'Put video or images on a visual lane (camera, screen, broll, graphics).');
      if (!AUDIO_LANES.has(lane.kind) && m.kind === 'audio') throw new AgentError('NO_VIDEO', `${m.name} is audio only, so it belongs on voice, music or sfx, not ${lane.kind}.`, 'Use lane "music", "voice" or "sfx".');
      const sIn = us(a.sourceIn ?? 0);
      const maxSrc = m.kind === 'image' ? Number.MAX_SAFE_INTEGER : m.durationUs;
      let sOut = a.sourceOut != null ? us(a.sourceOut) : a.duration != null ? sIn + us(a.duration) : m.kind === 'image' ? sIn + 3_000_000 : m.durationUs;
      if (sIn >= maxSrc) throw new AgentError('RANGE', `sourceIn ${a.sourceIn} s is past the end of ${m.name} (${sec(m.durationUs)} s).`, 'Use a time inside the file.');
      sOut = Math.min(sOut, maxSrc);
      if (sOut <= sIn) throw new AgentError('RANGE', 'sourceOut must be after sourceIn.', undefined);
      const start = a.start != null ? frameUs(doc, a.start) : lane.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0);
      const clip = newClip({ kind: 'media', mediaId: m.id, start, in: sIn, out: sOut, name: a.name ?? m.name, audio: m.hasAudio ? defaultAudio() : undefined, fit: a.fit ?? (m.role === 'screen' ? 'contain' : 'cover') });
      return { ops: insertClipOps(doc, lane.id, clip, !!a.insert), summary: `Add ${m.name} to ${lane.kind} at ${sec(start)} s`, result: { clip: clip.id, lane: lane.id, start: sec(start), end: sec(start + clipDuration(clip)) } };
    },
  }),

  defineEdit({
    name: 'split', title: 'Split clips', group: 'timeline',
    description: 'Cut clips in two at a timeline time (seconds; snapped to the nearest frame). With no clips or lanes given it is the blade-all tool: every unlocked clip under that time is cut. Linked clips (camera plus its detached audio) are cut together. Returns the ids of the new right-hand parts.',
    input: {
      at: Seconds.describe('Timeline time in seconds'),
      clips: z.array(Ref).max(200).optional().describe('Only these clips (and their linked partners)'),
      lanes: z.array(LaneRef).max(20).optional().describe('Only clips on these lanes'),
    },
    examples: [{ args: { at: 5.2 } }, { args: { at: 5.2, clips: ['clip_abc'] } }],
    plan: (doc, a) => {
      const t = frameUs(doc, a.at);
      let target: string[];
      if (a.clips?.length) {
        target = a.clips.map((id) => { const { clip } = clipRef(doc, id, { unlocked: true }); insideClip(clip, t, 'split point'); return id; });
      } else {
        const lanes = a.lanes?.map((l) => laneRef(doc, l).id);
        target = doc.lanes.filter((l) => !l.locked && (!lanes || lanes.includes(l.id))).flatMap((l) => l.clips.filter((c) => c.start < t && t < clipEnd(c)).map((c) => c.id));
        if (!target.length) throw new AgentError('NOTHING_THERE', `No unlocked clip crosses ${sec(t)} s${a.lanes ? ' on those lanes' : ''}.`, 'Split inside a clip; get_timeline shows clip start and end times.');
      }
      const ops = splitOps(doc, target, t);
      const created = ops.filter((o): o is Extract<Op, { op: 'addClip' }> => o.op === 'addClip').map((o) => o.clip.id);
      return { ops, summary: `Split ${created.length} clip(s) at ${sec(t)} s`, result: { rightParts: created } };
    },
  }),

  defineEdit({
    name: 'trim_clip', title: 'Trim a clip edge', group: 'timeline',
    description: 'Move the start or end edge of a clip. Give `to` (timeline seconds where the edge should land) or `by` (seconds to move it; positive moves later). ripple:true (default) moves later clips on the same lane so no gap or overlap appears; ripple:false leaves them in place. Edges cannot extend past the source media.',
    input: {
      clip: Ref, edge: z.enum(['start', 'end']),
      to: Seconds.optional().describe('Timeline time for the edge'),
      by: SecondsDelta.optional().describe('Move the edge by this many seconds'),
      ripple: z.boolean().optional().describe('Close or open space after the clip on its lane (default true)'),
    },
    examples: [{ args: { clip: 'clip_abc', edge: 'end', by: -0.5 }, note: 'Shorten by half a second' }, { args: { clip: 'clip_abc', edge: 'start', to: 2.0, ripple: false } }],
    plan: (doc, a) => {
      const { clip } = clipRef(doc, a.clip, { unlocked: true });
      if ((a.to == null) === (a.by == null)) throw new AgentError('INVALID_ARGS', 'Give exactly one of `to` or `by`.', 'For example {"clip":"...","edge":"end","by":-0.5}.');
      const edgeAt = a.edge === 'start' ? clip.start : clipEnd(clip);
      const target = a.to != null ? frameUs(doc, a.to) : Math.max(0, edgeAt + us(a.by!));
      if (a.edge === 'end' && target <= clip.start) throw new AgentError('RANGE', `The end would land at or before the clip start (${sec(clip.start)} s).`, 'Use delete_clips to remove a clip.');
      if (a.edge === 'start' && target >= clipEnd(clip)) throw new AgentError('RANGE', `The start would land at or after the clip end (${sec(clipEnd(clip))} s).`, 'Use delete_clips to remove a clip.');
      const ripple = a.ripple ?? true;
      const ops = trimOps(doc, clip.id, a.edge, target, { ripple });
      return { ops, summary: `Trim ${a.edge} of ${clip.name ?? clip.id} to ${sec(target)} s${ripple ? ' (ripple)' : ''}` };
    },
  }),

  defineEdit({
    name: 'move_clip', title: 'Move a clip', group: 'timeline',
    description: 'Move a clip to a new start time and/or another lane of a compatible kind. Give `start` (timeline seconds) or `by` (seconds; negative is earlier). Linked partners move by the same amount. The clip overwrites whatever is at its destination (like a drag in the timeline).',
    input: { clip: Ref, start: Seconds.optional(), by: SecondsDelta.optional(), lane: LaneRef.optional().describe('Destination lane (default: stay)') },
    examples: [{ args: { clip: 'clip_abc', start: 12 } }, { args: { clip: 'clip_abc', by: -0.25, lane: 'graphics' } }],
    plan: (doc, a) => {
      const { clip, lane } = clipRef(doc, a.clip, { unlocked: true });
      if (a.start != null && a.by != null) throw new AgentError('INVALID_ARGS', 'Give `start` or `by`, not both.', undefined);
      const dest = a.lane ? laneRef(doc, a.lane, { unlocked: true }) : lane;
      if (AUDIO_LANES.has(dest.kind) !== AUDIO_LANES.has(lane.kind)) throw new AgentError('LANE_KIND', `A clip on the ${lane.kind} lane cannot move to the ${dest.kind} lane.`, 'Audio clips stay on voice/music/sfx; visual clips on visual lanes. detach_audio splits sound from a video clip.');
      const start = a.start != null ? frameUs(doc, a.start) : Math.max(0, clip.start + us(a.by ?? 0));
      return { ops: moveClipOps(doc, clip.id, dest.id, start), summary: `Move ${clip.name ?? clip.id} to ${sec(start)} s${dest.id !== lane.id ? ` on ${dest.kind}` : ''}` };
    },
  }),

  defineEdit({
    name: 'delete_clips', title: 'Delete clips', group: 'timeline', destructive: true,
    description: 'Remove clips (with their linked partners). ripple:true (default) closes the gap on their lanes; ripple:false leaves an empty gap. Undoable.',
    input: { clips: z.array(Ref).min(1).max(500), ripple: z.boolean().optional() },
    examples: [{ args: { clips: ['clip_abc'] } }, { args: { clips: ['clip_a', 'clip_b'], ripple: false } }],
    plan: (doc, a) => {
      for (const id of a.clips) clipRef(doc, id, { unlocked: true });
      const ripple = a.ripple ?? true;
      return { ops: deleteClipsOps(doc, a.clips, ripple), summary: `${ripple ? 'Ripple delete' : 'Delete'} ${a.clips.length} clip(s)` };
    },
  }),

  defineEdit({
    name: 'delete_range', title: 'Delete a time range', group: 'timeline', destructive: true,
    description: 'Remove everything between two timeline times (seconds). ripple:true (default) closes the gap on every unlocked lane, keeping picture, sound and captions in sync; markers inside go and later ones move. ripple:false lifts the content and leaves a gap. Restrict to some lanes with `lanes`. Use several `ranges` to make many cuts at once.',
    input: {
      from: Seconds.optional(), to: Seconds.optional(),
      ranges: z.array(z.object({ from: Seconds, to: Seconds })).max(500).optional().describe('Several ranges at once (instead of from/to)'),
      lanes: z.array(LaneRef).max(20).optional(),
      ripple: z.boolean().optional(),
    },
    examples: [{ args: { from: 3.6, to: 4.65 } }, { args: { ranges: [{ from: 1, to: 1.4 }, { from: 7.2, to: 8 }] } }, { args: { from: 10, to: 12, lanes: ['broll'], ripple: false } }],
    plan: (doc, a) => {
      const raw = a.ranges ?? (a.from != null && a.to != null ? [{ from: a.from, to: a.to }] : null);
      if (!raw?.length) throw new AgentError('INVALID_ARGS', 'Give from and to, or ranges.', 'For example {"from":3.6,"to":4.65}.');
      const end = timelineDuration(doc);
      const ranges = mergeRanges(raw.map((r) => ({ from: frameUs(doc, r.from), to: Math.min(end, frameUs(doc, r.to)) })));
      for (const r of raw) if (r.to <= r.from) throw new AgentError('RANGE', `Range ${r.from} to ${r.to} s is empty or backwards.`, '`to` must be after `from`.');
      if (!ranges.length) throw new AgentError('PAST_END', `Those ranges are past the end of the timeline (${sec(end)} s).`, undefined);
      const laneIds = a.lanes?.map((l) => laneRef(doc, l, { unlocked: true }).id);
      const ripple = a.ripple ?? true;
      let ops: Op[];
      if (ripple) ops = rippleDeleteRangesOps(doc, ranges, laneIds);
      else {
        const tx = new Tx(doc);
        for (const lane of doc.lanes.filter((l) => !l.locked && (!laneIds || laneIds.includes(l.id)))) for (const r of ranges) for (const op of liftRangeOps(tx.doc, lane.id, r.from, r.to)) tx.do(op);
        ops = tx.ops;
      }
      const removed = ranges.reduce((n, r) => n + r.to - r.from, 0);
      return { ops, summary: `${ripple ? 'Cut' : 'Lift'} ${ranges.length} range(s), ${sec(removed)} s`, result: { removedSeconds: sec(removed) } };
    },
  }),

  defineEdit({
    name: 'close_gaps', title: 'Close empty gaps', group: 'timeline', destructive: true,
    description: 'Remove stretches of the timeline where no lane has anything (black, silent gaps), pulling everything after them earlier. Gaps shorter than minGap seconds are kept.',
    input: { minGap: z.number().min(0).max(60).optional().describe('Ignore gaps shorter than this (seconds, default 0.04)') },
    examples: [{ args: {} }],
    plan: (doc, a) => {
      const min = us(a.minGap ?? 0.04);
      const spans = mergeRanges(doc.lanes.flatMap((l) => l.clips.map((c) => ({ from: c.start, to: clipEnd(c) }))));
      const gaps: Array<{ from: number; to: number }> = [];
      let t = 0;
      for (const s of spans) { if (s.from - t >= min) gaps.push({ from: t, to: s.from }); t = Math.max(t, s.to); }
      if (!gaps.length) return { ops: [], summary: 'No gaps to close' };
      return { ops: rippleDeleteRangesOps(doc, gaps), summary: `Close ${gaps.length} gap(s), ${sec(gaps.reduce((n, g) => n + g.to - g.from, 0))} s`, result: { gaps: gaps.map((g) => ({ from: sec(g.from), to: sec(g.to) })) } };
    },
  }),

  defineEdit({
    name: 'slip_clip', title: 'Slip a clip', group: 'timeline', idempotent: false,
    description: 'Keep a clip where it is on the timeline but show a different part of its source: by > 0 shows later material, by < 0 earlier (seconds). Clamped to the source media.',
    input: { clip: Ref, by: SecondsDelta },
    examples: [{ args: { clip: 'clip_abc', by: 1.5 } }],
    plan: (doc, a) => {
      const { clip } = clipRef(doc, a.clip, { unlocked: true });
      if (clip.kind !== 'media') throw new AgentError('NOT_MEDIA', 'Only media clips can be slipped.', undefined);
      return { ops: slipOps(doc, clip.id, us(a.by)), summary: `Slip ${clip.name ?? clip.id} by ${a.by} s` };
    },
  }),

  defineEdit({
    name: 'roll_edit', title: 'Roll an edit point', group: 'timeline',
    description: 'Move the cut between two adjacent clips on the same lane by `by` seconds (positive: the left clip gets longer and the right one shorter). The total length stays the same.',
    input: { left: Ref, right: Ref, by: SecondsDelta },
    examples: [{ args: { left: 'clip_a', right: 'clip_b', by: 0.2 } }],
    plan: (doc, a) => {
      const l = clipRef(doc, a.left, { unlocked: true }), r = clipRef(doc, a.right, { unlocked: true });
      if (l.lane.id !== r.lane.id) throw new AgentError('RANGE', 'Both clips must be on the same lane.', undefined);
      if (Math.abs(clipEnd(l.clip) - r.clip.start) > 2000) throw new AgentError('RANGE', `${a.left} ends at ${sec(clipEnd(l.clip))} s but ${a.right} starts at ${sec(r.clip.start)} s: they are not adjacent.`, 'Roll works on two touching clips; use trim_clip otherwise.');
      return { ops: rollOps(doc, l.clip.id, r.clip.id, us(a.by)), summary: `Roll edit by ${a.by} s` };
    },
  }),

  defineEdit({
    name: 'duplicate_clip', title: 'Duplicate a clip', group: 'timeline',
    description: 'Copy a clip (with all its effects, keyframes and text) to `at` seconds on the same lane, or right after itself.',
    input: { clip: Ref, at: Seconds.optional() },
    examples: [{ args: { clip: 'clip_abc' } }, { args: { clip: 'clip_abc', at: 20 } }],
    plan: (doc, a) => {
      clipRef(doc, a.clip, { unlocked: true });
      const ops = duplicateClipOps(doc, a.clip, a.at != null ? frameUs(doc, a.at) : undefined);
      const added = ops.find((o): o is Extract<Op, { op: 'addClip' }> => o.op === 'addClip')!;
      return { ops, summary: 'Duplicate clip', result: { clip: added.clip.id, start: sec(added.clip.start) } };
    },
  }),

  defineEdit({
    name: 'link_clips', title: 'Link or unlink clips', group: 'timeline',
    description: 'Link clips so they move, split and delete together (for example a camera clip and its separate audio), or unlink them with link:false.',
    input: { clips: z.array(Ref).min(1).max(50), link: z.boolean().optional().describe('true (default) links, false unlinks') },
    examples: [{ args: { clips: ['clip_video', 'clip_audio'] } }, { args: { clips: ['clip_video'], link: false } }],
    plan: (doc, a) => {
      const link = a.link ?? true;
      if (link && a.clips.length < 2) throw new AgentError('INVALID_ARGS', 'Linking needs at least two clips.', undefined);
      const group = uid('link');
      const ops: Op[] = a.clips.map((id) => { const { clip } = clipRef(doc, id); return link ? { op: 'updateClip' as const, id: clip.id, patch: { linkGroup: group } } : { op: 'updateClip' as const, id: clip.id, patch: {}, unset: ['linkGroup'] }; });
      return { ops, summary: `${link ? 'Link' : 'Unlink'} ${ids(a.clips)}` };
    },
  }),
];

/** Lanes and their first free time, used by get_started and other tools. */
export function laneEnds(doc: Project) {
  return doc.lanes.map((l) => ({ id: l.id, kind: l.kind, end: sec(l.clips.reduce((e, c) => Math.max(e, clipEnd(c)), 0)) }));
}
export { findClip };
