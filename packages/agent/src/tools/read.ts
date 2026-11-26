import { z } from 'zod';
import {
  BLEND_MODES, CANVAS_PRESETS, COMMON_FPS, EASES, EFFECT_DEFS, EXPORT_PRESETS, FIT_MODES, LANE_LABEL, RAMP_PRESETS, TEXT_ANIMATIONS, TRANSITIONS,
  clipEnd, timelineDuration, type Project,
} from '@director/engine';
import { CAPTION_STYLES, DEFAULT_FILLERS, editPacing, comparePacing, timelineWords, type Pacing } from '@director/analysis';
import { compileDirector, timelineSummary, ACTION_TYPES, DIRECTOR_SYSTEM } from '@director/ai/director/index';
import { phrases } from '@director/ai/structure/index';
import { AgentError, GROUP_LABELS, defineEdit, defineRead, noProject, type AgentContext, type ToolDef } from '../core';
import { LAYOUTS, KEYFRAME_PROPERTIES } from './clip';
import { findPhrase, noTranscript } from './transcript';
import { LANE_KINDS, Ref, Seconds, clipDetail, clipRef, clipSummary, laneRef, sec, us } from '../units';

export const docOf = (ctx: AgentContext): Project => { const d = ctx.getDoc(); if (!d) throw noProject(); return d; };

export function capabilities(topic?: string) {
  const all = {
    units: 'Times are seconds on the timeline (3 decimals; edit positions snap to the nearest frame). Positions x/y are project pixels from the frame center, +x right, +y down. Scale 1 fills the frame per the clip fit. Volume is dB. Ids come from read tools.',
    laneKinds: LANE_KINDS.map((k) => ({ kind: k, label: LANE_LABEL[k], audio: ['voice', 'music', 'sfx'].includes(k) })),
    effects: Object.values(EFFECT_DEFS).map((d) => ({ type: d.type, label: d.label, description: d.description, addable: d.addable, params: d.params.map((p) => ({ key: p.key, min: p.min, max: p.max, default: p.def ?? null, unit: p.unit === 's' ? 'seconds from clip start' : p.unit || null, description: p.description })), ...(d.extras ? { extras: d.extras.map((x) => ({ key: x.key, kind: x.kind, values: x.values, default: x.def, description: x.description })) } : {}) })),
    transitions: TRANSITIONS,
    textAnimations: TEXT_ANIMATIONS,
    captionStyles: CAPTION_STYLES.map((s) => ({ id: s.id, label: s.label, position: s.position, font: s.text.font, size: s.text.size, color: s.text.color, highlightColor: s.text.highlightColor, uppercase: !!s.text.uppercase })),
    speedRamps: Object.entries(RAMP_PRESETS).map(([id, r]) => ({ id, label: r.label, points: r.points })),
    layouts: LAYOUTS,
    keyframeProperties: KEYFRAME_PROPERTIES,
    eases: EASES, blendModes: BLEND_MODES, fitModes: FIT_MODES,
    canvasPresets: CANVAS_PRESETS, frameRates: Object.keys(COMMON_FPS),
    exportPresets: Object.entries(EXPORT_PRESETS).map(([id, p]) => ({ id, label: p.label, width: p.width, height: p.height, fps: p.fps.num / p.fps.den, codec: p.codec })),
    markerKinds: ['note', 'retake', 'cue', 'chapter', 'beat', 'good', 'bad'],
    fillerWords: DEFAULT_FILLERS,
  };
  if (!topic) return all;
  const key = Object.keys(all).find((k) => k.toLowerCase() === topic.toLowerCase().replace(/[-_ ]/g, '')) ?? Object.keys(all).find((k) => k.toLowerCase().startsWith(topic.toLowerCase().slice(0, 4)));
  if (!key) throw new AgentError('UNKNOWN_TOPIC', `No capability topic "${topic}". Topics: ${Object.keys(all).join(', ')}.`, undefined);
  return { [key]: (all as Record<string, unknown>)[key] };
}

const WORKFLOW = [
  'Read: get_timeline (structure and ids), get_transcript (what is said, with word indices), render_contact_sheet or render_frame (what it looks like).',
  'Rough cut: auto_cut (pauses, fillers), cut_words (remove phrases by text), delete_range, or make_reel for the whole automatic pass.',
  'Shape: split, trim_clip, move_clip, roll_edit, slip_clip; set_speed; freeze_frame; detach_audio for J and L cuts.',
  'Polish: add_effect (color, zoom punch-ins, vignette, LUT), copy_effects, set_transition, set_layout, set_keyframes for motion.',
  'Words on screen: add_text for titles, generate_captions then style_captions.',
  'Sound: import_media music, add_clip to the music lane, set_audio (volume, fades, duckUnderVoice), detect_beats to cut on the beat.',
  'Check: render_contact_sheet, analyze_pacing (optionally against a swipe reference), then export_video and get_export_status.',
  'Every edit is one undo step. Use dryRun to preview, batch for several edits at once, expectRevision to avoid clobbering the person\'s own changes.',
];

export function readTools(getTools: () => Map<string, ToolDef>): ToolDef[] {
  return [
    defineRead({
      name: 'get_started', title: 'Start here', group: 'start',
      description: 'Orientation for a new session: what is open, the permission mode (ask: each change waits for the person to approve it in Director; auto: changes apply at once, all undoable), the units, a professional workflow, and every tool by group. Call this first.',
      input: {},
      examples: [{ args: {} }],
      run: (ctx) => {
        const doc = ctx.getDoc();
        const info = ctx.host.info?.();
        const groups: Record<string, string[]> = {};
        for (const t of getTools().values()) (groups[GROUP_LABELS[t.group]] ??= []).push(t.name);
        return {
          app: 'Director, a desktop video editor for short-form video (Reels, TikTok, Shorts) and YouTube.',
          you: ctx.client,
          mode: info?.mode ?? 'ask',
          modeMeaning: (info?.mode ?? 'ask') === 'ask' ? 'Each change waits for the person to click Accept in Director (read tools never ask). Group related edits with batch so they approve once.' : 'Changes apply immediately. Each is one undo step and the person can revert all agent changes at once.',
          project: doc ? { name: doc.name, durationSec: sec(timelineDuration(doc)), canvas: `${doc.canvas.width}x${doc.canvas.height} @ ${(doc.canvas.fps.num / doc.canvas.fps.den).toFixed(2)} fps`, lanes: doc.lanes.map((l) => `${l.kind}:${l.clips.length}`).join(' '), media: Object.keys(doc.media).length, transcript: !!doc.transcript?.length, revision: ctx.revision() } : null,
          next: doc ? 'Call get_timeline, then get_transcript if there is speech.' : 'No project is open: list_projects then open_project, or create_project.',
          units: capabilities('units'),
          workflow: WORKFLOW,
          tools: groups,
          help: 'describe_tool {"name": "..."} gives any tool\'s schema and examples; get_capabilities lists effects, transitions, caption styles and presets.',
        };
      },
    }),
    defineRead({
      name: 'get_capabilities', title: 'What the editor can do', group: 'start',
      description: 'The creative vocabulary with exact names, ranges and units: effects and every parameter, transitions, text animations, caption styles, speed-ramp presets, layouts, keyframe properties, eases, blend and fit modes, canvas and export presets, lane and marker kinds. topic narrows it (effects, transitions, captionStyles, exportPresets, ...).',
      input: { topic: z.string().max(40).optional() },
      examples: [{ args: {} }, { args: { topic: 'effects' } }],
      run: (_ctx, a) => capabilities(a.topic),
    }),
    defineRead({
      name: 'describe_tool', title: 'Explain a tool', group: 'start',
      description: 'A tool\'s full description, JSON schema of its arguments, examples, and whether it changes the project.',
      input: { name: z.string().min(1).max(64) },
      examples: [{ args: { name: 'add_effect' } }],
      run: (_ctx, a) => {
        const t = getTools().get(a.name);
        if (!t) throw new AgentError('UNKNOWN_TOOL', `There is no tool called ${a.name}.`, 'get_started lists every tool.');
        return { name: t.name, title: t.title, group: GROUP_LABELS[t.group], changesProject: t.access === 'edit' || !!t.mutates, description: t.description, inputSchema: z.toJSONSchema(t.input, { io: 'input' }), examples: t.examples };
      },
    }),
    defineRead({
      name: 'get_timeline', title: 'Read the timeline', group: 'read',
      description: 'The open project: name, canvas, length, revision, lanes with their clips (ids, times in seconds, media, text, effects, transitions) and markers. detail:"full" adds every clip property (transform, keyframes, effect params, audio, text style). Narrow with lanes (ids, names, or kinds; a kind lists every lane of that kind) and a time window (from/to seconds).',
      input: { detail: z.enum(['summary', 'full']).optional(), lanes: z.array(z.string().max(100)).max(20).optional(), from: Seconds.optional(), to: Seconds.optional() },
      examples: [{ args: {} }, { args: { detail: 'full', lanes: ['camera'], from: 0, to: 10 } }],
      run: (ctx, a) => {
        const doc = docOf(ctx);
        // A kind means every lane of that kind (a project can have several titles or camera lanes).
        const lanes = a.lanes?.flatMap((l) => { const k = l.trim().toLowerCase(); const all = doc.lanes.filter((x) => x.kind === k); return all.length ? all.map((x) => x.id) : [laneRef(doc, l).id]; });
        const from = a.from != null ? us(a.from) : 0, to = a.to != null ? us(a.to) : Infinity;
        return {
          name: doc.name, revision: ctx.revision(),
          canvas: { width: doc.canvas.width, height: doc.canvas.height, fps: Math.round((doc.canvas.fps.num / doc.canvas.fps.den) * 1000) / 1000, background: doc.canvas.background },
          durationSec: sec(timelineDuration(doc)),
          settings: doc.settings,
          lanes: doc.lanes.filter((l) => !lanes || lanes.includes(l.id)).map((l, i) => ({
            id: l.id, kind: l.kind, name: l.name, index: i, ...(l.muted ? { muted: true } : {}), ...(l.solo ? { solo: true } : {}), ...(l.hidden ? { hidden: true } : {}), ...(l.locked ? { locked: true } : {}),
            clips: l.clips.filter((c) => clipEnd(c) > from && c.start < to).map((c) => (a.detail === 'full' ? clipDetail(doc, c, l) : clipSummary(doc, c, l))),
          })),
          markers: doc.markers.filter((m) => m.t >= from && m.t <= to).map((m) => ({ id: m.id, at: sec(m.t), kind: m.kind, label: m.label, ...(m.duration ? { duration: sec(m.duration) } : {}) })),
          script: doc.scriptText ? { attached: true, ref: doc.scriptRef ?? null, chars: doc.scriptText.length } : null,
          transcribed: (doc.transcript ?? []).map((t) => t.mediaId),
        };
      },
    }),
    defineRead({
      name: 'get_clip', title: 'Read one clip', group: 'read',
      description: 'Every property of a clip: times and source range (seconds), media info, speed, transform with keyframes (timeline and clip seconds), effects with parameters, audio mix, text and style, transition.',
      input: { clip: Ref },
      examples: [{ args: { clip: 'clip_abc' } }],
      run: (ctx, a) => { const doc = docOf(ctx); const { clip, lane } = clipRef(doc, a.clip); return { revision: ctx.revision(), clip: clipDetail(doc, clip, lane) }; },
    }),
    defineRead({
      name: 'list_media', title: 'List imported media', group: 'read',
      description: 'The project bin: each media item\'s id, name, kind (video, audio, image), duration (s), size, fps, whether it has audio, its role, whether it is transcribed, and how many clips use it. includePaths adds file paths on this Mac.',
      input: { includePaths: z.boolean().optional() },
      examples: [{ args: {} }],
      run: (ctx, a) => {
        const doc = docOf(ctx);
        const uses = new Map<string, number>();
        for (const l of doc.lanes) for (const c of l.clips) if (c.mediaId) uses.set(c.mediaId, (uses.get(c.mediaId) ?? 0) + 1);
        const tr = new Set((doc.transcript ?? []).map((t) => t.mediaId));
        return { media: Object.values(doc.media).map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: sec(m.durationUs), ...(m.width ? { width: m.width, height: m.height } : {}), ...(m.fps ? { fps: Math.round((m.fps.num / m.fps.den) * 100) / 100 } : {}), hasAudio: m.hasAudio, role: m.role ?? null, transcribed: tr.has(m.id), usedBy: uses.get(m.id) ?? 0, ...(m.missing ? { missing: true } : {}), ...(a.includePaths ? { path: m.path } : {}) })) };
      },
    }),
    defineRead({
      name: 'get_transcript', title: 'Read what is said', group: 'read',
      description: 'Transcript words as they fall on the current timeline (after cuts), each with its index (for cut_words), text, start and end in seconds and clip id, plus phrases (sentences) with times. Narrow with from/to seconds.',
      input: { from: Seconds.optional(), to: Seconds.optional() },
      examples: [{ args: {} }, { args: { from: 0, to: 5 } }],
      run: (ctx, a) => {
        const doc = docOf(ctx);
        const all = timelineWords(doc);
        if (!all.length) throw noTranscript();
        const from = a.from != null ? us(a.from) : 0, to = a.to != null ? us(a.to) : Infinity;
        const words = all.map((w, i) => ({ i, text: w.text, start: sec(w.start), end: sec(w.end), clip: w.clipId, ...(w.p != null && w.p < 0.5 ? { lowConfidence: true } : {}) })).filter((w) => us(w.end) > from && us(w.start) < to);
        return { revision: ctx.revision(), count: all.length, phrases: phrases(words.map((w) => ({ text: w.text, start: w.start, end: w.end }))), words };
      },
    }),
    defineRead({
      name: 'find_in_transcript', title: 'Find words', group: 'read',
      description: 'Find where a word or phrase is said (ignoring case and punctuation): every occurrence with its timeline start/end in seconds, word indices for cut_words, and the surrounding words.',
      input: { text: z.string().min(1).max(500), context: z.number().int().min(0).max(30).optional().describe('Words of context each side (default 5)') },
      examples: [{ args: { text: 'link in bio' } }],
      run: (ctx, a) => {
        const doc = docOf(ctx);
        const words = timelineWords(doc);
        if (!words.length) throw noTranscript();
        const n = a.context ?? 5;
        const hits = findPhrase(words, a.text).map((h) => ({ first: h.first, last: h.last, start: sec(words[h.first]!.start), end: sec(words[h.last]!.end), context: words.slice(Math.max(0, h.first - n), h.last + n + 1).map((w) => w.text).join(' ') }));
        return { query: a.text, matches: hits.length, hits };
      },
    }),
    defineRead({
      name: 'analyze_pacing', title: 'Measure pacing', group: 'read',
      description: 'Pacing of the edit: length, shots (camera, screen and b-roll changes and zooms), average and median shot length, cuts per minute, first cut time, words per second and per minute, share of runtime with speech. With referenceId (a Swipe reference from list_references) it compares metric by metric and says what to change.',
      input: { referenceId: z.string().max(64).optional() },
      examples: [{ args: {} }, { args: { referenceId: 'ref_123' } }],
      run: async (ctx, a) => {
        const doc = docOf(ctx);
        const words = timelineWords(doc).map((w) => ({ text: w.text, start: w.start / 1e6, end: w.end / 1e6 }));
        const yours = editPacing(doc, words);
        if (!a.referenceId) return { pacing: yours };
        const brand = ctx.host.activeBrand?.();
        if (!brand || !ctx.host.library) throw new AgentError('UNAVAILABLE', 'The Swipe library is not available.', undefined);
        const ref = await ctx.host.library('swipe.get', brand, a.referenceId) as { analysis?: { pacing?: Pacing } } | null;
        if (!ref) throw new AgentError('REFERENCE_NOT_FOUND', `No reference "${a.referenceId}" in the active brand.`, 'list_references shows them.');
        if (!ref.analysis?.pacing) throw new AgentError('NOT_ANALYZED', 'That reference has not been analyzed yet.', 'Analyze it in the Swipe workspace first.');
        return { pacing: yours, reference: ref.analysis.pacing, comparison: comparePacing(yours, ref.analysis.pacing) };
      },
    }),

    // Compatibility with the M6 bridge (unchanged behavior).
    defineRead({
      name: 'get_project', title: 'Get project (compatibility)', group: 'read',
      description: 'The open project as a short text summary plus lanes, clips (no file paths), markers and script. Kept for clients written for the first version of this bridge; get_timeline is richer.',
      input: {},
      examples: [{ args: {} }],
      run: (ctx) => {
        const doc = docOf(ctx);
        return { summary: timelineSummary(doc), project: {
          name: doc.name, canvas: { width: doc.canvas.width, height: doc.canvas.height, fps: doc.canvas.fps }, durationSec: sec(timelineDuration(doc)),
          lanes: doc.lanes.map((l) => ({ id: l.id, kind: l.kind, muted: l.muted, hidden: l.hidden, locked: l.locked, clips: l.clips.map((c) => ({ id: c.id, kind: c.kind, startSec: sec(c.start), durationSec: sec(clipEnd(c) - c.start), text: c.text?.content, effects: c.effects.map((e) => e.type) })) })),
          markers: doc.markers.map((m) => ({ id: m.id, kind: m.kind, tSec: sec(m.t), label: m.label })), script: doc.scriptText ?? null,
        } };
      },
    }),
    defineRead({
      name: 'list_ops', title: 'List edit actions (compatibility)', group: 'read',
      description: 'The edit-action vocabulary that propose_edits accepts, with its rules. Kept for clients written for the first version of this bridge.',
      input: {},
      examples: [{ args: {} }],
      run: () => ({ text: [DIRECTOR_SYSTEM, '', 'propose_edits takes { summary, actions: [{ type, start, end, text, amount, reason }] } with times in seconds on the current timeline.', 'Advanced: { summary, ops } with primitive ops (addClip, updateClip, removeClip, addMarker, ...) as in the project file format.', 'Nothing changes until the person accepts the proposal in Director; it then applies as one undo step.', '', 'This bridge now has a tool for every editing operation: call get_started.'].join('\n') }),
    }),
    { ...defineEdit({
      name: 'propose_edits', title: 'Propose edits for approval', group: 'history',
      description: 'Propose a set of high-level edit actions (cut, zoom, broll, text, marker; times in seconds) or primitive ops. Director validates them, shows them to the person and always waits for Accept or Reject, whatever the mode. Applies as one undo step.',
      input: {
        summary: z.string().min(1).max(1000),
        actions: z.array(z.object({ type: z.enum(ACTION_TYPES), start: z.number(), end: z.number(), text: z.string().default(''), amount: z.number().default(0), reason: z.string() })).max(200).optional(),
        ops: z.array(z.unknown()).max(5000).optional(),
      },
      examples: [{ args: { summary: 'Tighten the hook', actions: [{ type: 'cut', start: 1.9, end: 2.7, reason: 'Dead air after the hook' }] } }],
      plan: (doc, a) => {
        if (a.actions?.length) {
          const plan = compileDirector(doc, a.actions.map((x) => ({ ...x, text: x.text ?? '', amount: x.amount ?? 0 })));
          if (!plan.ok) throw new AgentError('REJECTED', `Rejected, nothing changed:\n${plan.problems.map((p) => `- ${p.index >= 0 ? `action ${p.index}: ` : ''}${p.reason}`).join('\n')}`, 'list_ops explains the rules.');
          return { ops: plan.ops, summary: a.summary, preview: plan.preview.map((p) => `${p.label}: ${p.reason}`), label: `MCP: ${a.summary.slice(0, 60)}` };
        }
        if (a.ops?.length) {
          const parsed = (getTools().get('apply_ops')!.plan!)(doc, { ops: a.ops, summary: a.summary } as never, {});
          return { ...parsed, preview: [`${parsed.ops.length} primitive op(s): ${[...new Set(parsed.ops.map((o) => o.op))].join(', ')}`], label: `MCP: ${a.summary.slice(0, 60)}` };
        }
        throw new AgentError('INVALID_ARGS', 'Nothing to propose: pass actions or ops.', undefined);
      },
    }), alwaysAsk: true } as ToolDef,
  ];
}
