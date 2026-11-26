import { z } from 'zod';
import { EXPORT_PRESETS, makeTemplate, timelineDuration, type Op } from '@director/engine';
import { captionsToSubtitles, timelineWords } from '@director/analysis';
import { AgentError, defineAct, defineRead, labelFor, noProject, type AgentContext, type ToolDef } from '../core';
import { Ref, Seconds, clipRef, sec, us } from '../units';
import { docOf } from './read';

/** A file name inside the export folder: no folders, no traversal, the right extension. */
export const FileName = (ext: string[]) => z.string().min(1).max(200)
  .refine((s) => !/[/\\]/.test(s) && !s.startsWith('.') && !s.includes('..') && !/[\u0000-\u001f]/.test(s), 'a plain file name (no folders); files are written to the export folder')
  .refine((s) => ext.some((e) => s.toLowerCase().endsWith(`.${e}`)), `must end in .${ext.join(' or .')}`);

function host<K extends keyof NonNullable<AgentContext['host']>>(ctx: AgentContext, k: K): NonNullable<AgentContext['host'][K]> {
  const f = ctx.host[k];
  if (!f) throw new AgentError('UNAVAILABLE', `This Director build cannot ${String(k)} here.`, undefined);
  return (typeof f === 'function' ? (f as (...a: unknown[]) => unknown).bind(ctx.host) : f) as NonNullable<AgentContext['host'][K]>;
}

export function toBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const image = (png: Uint8Array) => ({ data: toBase64(png), mimeType: 'image/png' as const });
const needClip = (ctx: AgentContext, id: string, video = false) => {
  const doc = docOf(ctx);
  const { clip, lane } = clipRef(doc, id, { unlocked: true });
  const m = clip.mediaId ? doc.media[clip.mediaId] : undefined;
  if (!m) throw new AgentError('NOT_MEDIA', `Clip ${id} is not a media clip.`, undefined);
  if (video && m.kind !== 'video') throw new AgentError('NOT_VIDEO', `Clip ${id} is ${m.kind}, not video.`, undefined);
  return { doc, clip, lane, media: m };
};

export function appTools(): ToolDef[] {
  return [
    // History
    defineRead({ name: 'get_history', title: 'Undo history', group: 'history', description: 'The undo and redo stacks (most recent first) with their labels, how many steps agents made, and the current revision.', input: {}, examples: [{ args: {} }], run: (ctx) => ({ revision: ctx.revision(), ...host(ctx, 'history')() }) }),
    defineAct({ name: 'undo', title: 'Undo', group: 'history', mutates: true, description: 'Undo the last `steps` changes (default 1), whoever made them. get_history shows what they are.', input: { steps: z.number().int().min(1).max(100).optional() }, examples: [{ args: {} }], describe: (a) => `Undo ${a.steps ?? 1} step(s)`, run: (ctx, a) => { const n = host(ctx, 'undo')(a.steps ?? 1); return { undone: n, revision: ctx.revision() }; } }),
    defineAct({ name: 'redo', title: 'Redo', group: 'history', mutates: true, description: 'Redo the last `steps` undone changes (default 1). Anything new done after an undo clears what can be redone.', input: { steps: z.number().int().min(1).max(100).optional() }, examples: [{ args: {} }], describe: (a) => `Redo ${a.steps ?? 1} step(s)`, run: (ctx, a) => { const n = host(ctx, 'redo')(a.steps ?? 1); return { redone: n, revision: ctx.revision() }; } }),
    defineAct({ name: 'revert_agent_changes', title: 'Revert all agent changes', group: 'history', mutates: true, destructive: true, description: 'Take back every change agents made in this session in one step, keeping the person\'s own edits. Itself undoable.', input: {}, examples: [{ args: {} }], describe: () => 'Revert all agent changes', run: (ctx) => ({ ...host(ctx, 'revertAgentChanges')(), revision: ctx.revision() }) }),

    // Media
    defineAct({
      name: 'import_media', title: 'Import media files', group: 'media', mutates: true,
      description: 'Add video, audio or image files (absolute paths on this Mac, or folders) to the project bin. Returns media ids for add_clip. role sets the natural lane: camera, screen, mic (voice), broll, music, sfx, image. Files already in the project are reported, not duplicated.',
      input: { paths: z.array(z.string().min(2).max(4096).refine((p) => p.startsWith('/'), 'absolute path')).min(1).max(200), role: z.enum(['camera', 'screen', 'mic', 'broll', 'music', 'sfx', 'image', 'other']).optional() },
      examples: [{ args: { paths: ['/Users/me/Movies/broll/laptop.mov'], role: 'broll' } }],
      describe: (a) => `Import ${a.paths.length} file(s)${a.role ? ` as ${a.role}` : ''}`,
      run: async (ctx, a) => {
        docOf(ctx);
        const r = await host(ctx, 'importMedia')(a.paths, a.role);
        const v = (m: { id: string; name: string; kind: string; durationUs: number; hasAudio: boolean }) => ({ id: m.id, name: m.name, kind: m.kind, duration: sec(m.durationUs), hasAudio: m.hasAudio });
        return { added: r.added.map(v), alreadyInProject: r.existing.map(v), failed: r.failed, revision: ctx.revision(), next: r.added.length ? 'Place them with add_clip {"media": id}.' : undefined };
      },
    }),
    defineRead({ name: 'list_takes', title: 'Recorded takes', group: 'media', description: 'Takes recorded with the teleprompter for this project, newest first: id, title, length (seconds), star rating, how many retake and cue markers, whether a screen recording and a script came with it. add_take puts one on the timeline.', input: {}, examples: [{ args: {} }], run: async (ctx) => ({ takes: (await host(ctx, 'listTakes')()).map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, duration: sec(t.durationUs), rating: t.rating, markers: t.markers, screen: t.hasScreen, script: t.hasScript })) }) }),
    defineAct({
      name: 'add_take', title: 'Put a take on the timeline', group: 'media', mutates: true,
      description: 'Put a recorded take (id from list_takes) at the end of the timeline: camera on the camera lane, its sound linked on the voice lane, the screen recording in sync on the screen lane, retake and cue markers at their times, and its script attached. Then transcribe and make_reel or edit by hand.',
      input: { take: z.string().min(1).max(64) },
      examples: [{ args: { take: 'take_1' } }],
      describe: (a) => `Add take ${a.take} to the timeline`,
      run: async (ctx, a) => {
        docOf(ctx);
        const takes = await host(ctx, 'listTakes')();
        const t = takes.find((x) => x.id === a.take || x.title === a.take);
        if (!t) throw new AgentError('TAKE_NOT_FOUND', `No take "${a.take}" for this project.`, 'list_takes shows the recorded takes.');
        const ok = await host(ctx, 'addTake')(t.dir);
        return { added: ok, take: t.id, revision: ctx.revision(), next: 'get_timeline shows the new clips; transcribe gives you the words.' };
      },
    }),
    defineAct({
      name: 'transcribe', title: 'Transcribe speech', group: 'media', mutates: true,
      description: 'Transcribe the speech on the timeline locally (whisper, nothing leaves this Mac) and store word timings in the project; needed for get_transcript, cut_words, auto_cut, captions and make_reel. Finds speech clips by itself; media limits it; force redoes existing transcripts. Can take a minute per few minutes of audio.',
      input: { media: z.array(Ref).max(50).optional(), force: z.boolean().optional(), model: z.string().max(40).optional() },
      examples: [{ args: {} }],
      describe: () => 'Transcribe the speech',
      run: async (ctx, a) => {
        const doc = docOf(ctx);
        for (const id of a.media ?? []) if (!doc.media[id]) throw new AgentError('MEDIA_NOT_FOUND', `No media "${id}".`, 'list_media shows ids.');
        const r = await host(ctx, 'transcribe')({ mediaIds: a.media, force: a.force, model: a.model });
        const words = timelineWords(ctx.getDoc()!).length;
        return { transcribed: r, wordsOnTimeline: words, revision: ctx.revision(), next: words ? 'get_transcript shows them.' : 'No speech was found on the timeline.' };
      },
    }),
    defineAct({ name: 'process_audio', title: 'Clean up or enhance a voice', group: 'audio', mutates: true, description: 'Remove background noise (denoise) and/or enhance a voice (EQ and compression) on a clip; the processed copy replaces its sound as one undo step (a video clip keeps its picture and gets the clean voice on the voice lane).', input: { clip: Ref, denoise: z.boolean().optional(), enhance: z.boolean().optional() }, examples: [{ args: { clip: 'clip_camera', denoise: true, enhance: true } }], describe: (a) => `${a.denoise ? 'Clean up' : ''}${a.denoise && a.enhance ? ' and ' : ''}${a.enhance ? 'enhance' : ''} voice`, run: async (ctx, a) => { if (!a.denoise && !a.enhance) throw new AgentError('INVALID_ARGS', 'Set denoise and/or enhance to true.', undefined); const { media } = needClip(ctx, a.clip); if (!media.hasAudio) throw new AgentError('NO_AUDIO', 'That clip has no sound.', undefined); if (!(await host(ctx, 'processAudio')(a.clip, a))) throw new AgentError('PROCESSING_FAILED', 'The voice could not be processed. Nothing changed.', undefined); return { ok: true, revision: ctx.revision() }; } }),
    defineAct({ name: 'detect_beats', title: 'Mark the beats', group: 'audio', mutates: true, description: 'Find the beats of a music clip and drop "beat" markers on the timeline, to cut on the beat (get_timeline lists them; remove_marker {"kind":"beat"} clears them).', input: { clip: Ref }, examples: [{ args: { clip: 'clip_music' } }], describe: () => 'Mark beats', run: async (ctx, a) => { needClip(ctx, a.clip); const n = await host(ctx, 'detectBeats')(a.clip); const doc = ctx.getDoc()!; return { markers: n, beats: doc.markers.filter((m) => m.kind === 'beat').slice(0, 400).map((m) => sec(m.t)), revision: ctx.revision() }; } }),
    defineAct({ name: 'auto_reframe', title: 'Auto reframe', group: 'media', mutates: true, description: 'Track the face in a wide video clip and keyframe its position so the person stays centered in a vertical frame.', input: { clip: Ref }, examples: [{ args: { clip: 'clip_camera' } }], describe: () => 'Auto reframe', run: async (ctx, a) => { needClip(ctx, a.clip, true); if (!(await host(ctx, 'autoReframe')(a.clip))) throw new AgentError('NO_FACE', 'No face was found in that clip to follow. Nothing changed.', 'Auto reframe needs a visible face; frame it by hand with set_clip x/y or animate x with set_keyframes.'); return { ok: true, revision: ctx.revision() }; } }),
    defineAct({
      name: 'detect_speakers', title: 'Who is talking when', group: 'media',
      description: 'Find the people in a video clip (one camera, or a split-screen remote interview with up to three people side by side) and who speaks when, from lip movement matched to the transcript. Returns each person\'s panel (left to right, normalized), seconds of talk per person, how clear the signal was (confidence 0 to 1) and sample turns with their words, so you can tell who is who. Needs the transcript (transcribe). The first run on a long video takes a few minutes; later runs are instant.',
      input: { clip: Ref, from: Seconds.optional().describe('Timeline seconds to start from (default the clip start)'), to: Seconds.optional().describe('Timeline seconds to stop at (default the clip end)') },
      examples: [{ args: { clip: 'clip_camera' } }, { args: { clip: 'clip_camera', from: 55, to: 300 } }],
      run: async (ctx, a) => {
        needClip(ctx, a.clip, true);
        const r = await host(ctx, 'detectSpeakers')(a.clip, a.from != null ? us(a.from) : undefined, a.to != null ? us(a.to) : undefined);
        return { ...r, sampleTurns: r.sampleTurns.map((t) => ({ ...t, start: sec(t.start), end: sec(t.end), note: 'source seconds' })) };
      },
    }),
    defineAct({
      name: 'speaker_layout', title: 'Cut to whoever is talking', group: 'media', mutates: true,
      description: 'Edit an interview or podcast clip like a multicam: a close shot of whoever is talking, everyone side by side (each filling half the frame) during quick back-and-forth, and long answers broken at pauses with alternating wide and tight framing so the picture keeps moving. Works on split-screen remote recordings (it crops each person out of their panel, removing letterbox bars) and on single-camera footage (alternating framing only). Shots are muted copies on "Speakers" lanes above the clip, so the original keeps the sound and running it again replaces the earlier layout. One undo step. Needs the transcript. Times (from, to, minShot, maxShot) are in seconds. dryRun reports the plan without changing anything.',
      input: {
        clip: Ref,
        from: Seconds.optional().describe('Timeline seconds to start from (default the clip start); use it to leave an edited intro alone'),
        to: Seconds.optional().describe('Timeline seconds to stop at (default the clip end)'),
        minShot: z.number().min(1).max(20).optional().describe('Shortest shot in seconds (default 2.5)'),
        maxShot: z.number().min(3).max(120).optional().describe('Longest single framing in seconds before it changes (default 9)'),
        punchIn: z.number().min(0).max(1).optional().describe('How much closer the tight framing is, 0 to 1 (default 0.18 = 18% closer; 0 = no punch-ins)'),
        splitOnExchange: z.boolean().optional().describe('Show everyone side by side during quick exchanges (default true)'),
        reactionEvery: z.number().int().min(0).max(20).optional().describe('In a long answer, every Nth framing shows everyone so the listener reacts on screen (default 4; 0 = never)'),
        names: z.array(z.string().min(1).max(60)).max(3).optional().describe('Names of the people left to right, for clip names'),
        dryRun: z.boolean().optional().describe('Report the plan without changing anything'),
      },
      examples: [{ args: { clip: 'clip_camera', from: 55 }, note: 'Leave the first 55 s alone' }, { args: { clip: 'clip_camera', punchIn: 0.25, maxShot: 7, names: ['Sam', 'Alex'], dryRun: true } }],
      describe: (a) => `Speaker layout${a.from != null || a.to != null ? ` from ${a.from ?? 'start'} to ${a.to ?? 'end'} s` : ''}`,
      run: async (ctx, a) => {
        needClip(ctx, a.clip, true);
        const r = await host(ctx, 'speakerLayout')(a.clip, { ...a, clip: undefined, from: a.from != null ? us(a.from) : undefined, to: a.to != null ? us(a.to) : undefined } as never);
        return { ...r, sampleTurns: r.sampleTurns.map((t) => ({ ...t, start: sec(t.start), end: sec(t.end) })), message: r.applied ? 'Applied as one undo step. Check it with render_contact_sheet.' : 'Dry run: nothing changed.', revision: ctx.revision() };
      },
    }),
    defineAct({ name: 'remove_background', title: 'Remove background', group: 'media', mutates: true, description: 'Cut the person out of a video clip (on-device segmentation) so lanes below show behind them. Takes a while on long clips.', input: { clip: Ref }, examples: [{ args: { clip: 'clip_camera' } }], describe: () => 'Remove background', run: async (ctx, a) => { needClip(ctx, a.clip, true); if (!(await host(ctx, 'removeBackground')(a.clip))) throw new AgentError('PROCESSING_FAILED', 'Background removal did not finish. Nothing changed.', undefined); return { ok: true, revision: ctx.revision() }; } }),
    defineAct({ name: 'stabilize', title: 'Stabilize', group: 'media', mutates: true, description: 'Smooth out handheld shake in a video clip (two-pass); the stabilized copy replaces the clip\'s source. smoothing 1 to 100 (default 15).', input: { clip: Ref, smoothing: z.number().int().min(1).max(100).optional() }, examples: [{ args: { clip: 'clip_broll' } }], describe: () => 'Stabilize', run: async (ctx, a) => { needClip(ctx, a.clip, true); if (!(await host(ctx, 'stabilize')(a.clip, a.smoothing))) throw new AgentError('PROCESSING_FAILED', 'Stabilizing did not finish. Nothing changed.', undefined); return { ok: true, revision: ctx.revision() }; } }),

    // Render
    defineRead({
      name: 'render_frame', title: 'See a frame', group: 'render',
      description: 'A PNG of the finished edit at time t (seconds): every lane, effect, transition, text and caption, as it will export. width in pixels (default 540).',
      input: { t: Seconds, width: z.number().int().min(64).max(2160).optional() },
      examples: [{ args: { t: 5 } }],
      run: async (ctx, a) => {
        const doc = docOf(ctx);
        const t = Math.min(us(a.t), Math.max(0, timelineDuration(doc) - 1));
        const r = await host(ctx, 'renderFrame')(t, a.width ?? 540);
        return { image: image(r.png), t: sec(t), width: r.width, height: r.height };
      },
    }),
    defineRead({
      name: 'render_contact_sheet', title: 'See the whole edit at a glance', group: 'render',
      description: 'One PNG grid of `count` frames evenly spaced from `from` to `to` seconds (default the whole timeline), each labelled with its time. The cheapest way to check an edit visually.',
      input: { from: Seconds.optional(), to: Seconds.optional(), count: z.number().int().min(1).max(48).optional(), columns: z.number().int().min(1).max(12).optional(), width: z.number().int().min(256).max(4096).optional().describe('Width of the whole sheet in pixels (default 1200)') },
      examples: [{ args: { count: 12 } }, { args: { from: 0, to: 6, count: 6, columns: 6 } }],
      run: async (ctx, a) => {
        const doc = docOf(ctx);
        const end = timelineDuration(doc);
        const from = a.from != null ? us(a.from) : 0, to = Math.min(end, a.to != null ? us(a.to) : end);
        if (to <= from) throw new AgentError('RANGE', '`to` must be after `from` and inside the timeline.', undefined);
        const n = a.count ?? 12;
        const times = Array.from({ length: n }, (_, i) => Math.min(to - 1, Math.round(from + ((i + 0.5) * (to - from)) / n)));
        const r = await host(ctx, 'contactSheet')(times, a.width ?? 1200, a.columns ?? Math.min(n, 6));
        return { image: image(r.png), times: times.map(sec), width: r.width, height: r.height };
      },
    }),

    // Export
    defineAct({
      name: 'export_video', title: 'Export the video', group: 'export', mutates: true,
      description: `Render the edit to an MP4 in the export folder. preset: ${Object.keys(EXPORT_PRESETS).join(', ')} (the project's shape decides the exact size). fileName is a plain name ending in .mp4 (default: the project name). from/to (seconds) export part of the timeline. normalizeLoudness (default true) sets -14 LUFS for social platforms. Returns a job id; poll get_export_status.`,
      input: { preset: z.enum(Object.keys(EXPORT_PRESETS) as [string, ...string[]]).optional(), fileName: FileName(['mp4']).optional(), from: Seconds.optional(), to: Seconds.optional(), normalizeLoudness: z.boolean().optional() },
      examples: [{ args: { preset: 'reels-30' } }, { args: { preset: 'youtube-1080', fileName: 'final.mp4', from: 0, to: 30 } }],
      describe: (a) => `Export ${a.fileName ?? 'the video'} (${a.preset ?? 'reels-30'})`,
      run: async (ctx, a) => {
        const doc = docOf(ctx);
        const end = timelineDuration(doc);
        if (!end) throw new AgentError('EMPTY', 'The timeline is empty.', 'Add clips first.');
        const fromUs = a.from != null ? us(a.from) : undefined, toUs = a.to != null ? Math.min(end, us(a.to)) : undefined;
        if (fromUs != null && toUs != null && toUs <= fromUs) throw new AgentError('RANGE', '`to` must be after `from`.', undefined);
        const r = await host(ctx, 'exportVideo')({ preset: a.preset ?? 'reels-30', fileName: a.fileName, fromUs, toUs, loudness: a.normalizeLoudness ?? true });
        return { job: r.jobId, file: r.path.split('/').pop(), status: 'queued', next: 'Poll get_export_status {"job": id} every few seconds.' };
      },
    }),
    defineRead({ name: 'get_export_status', title: 'Export progress', group: 'export', description: 'Status of export jobs (queued, audio, rendering, finishing, done, error, cancelled) with progress 0 to 1, and for finished ones the file, size, loudness and length. job narrows to one.', input: { job: z.string().max(64).optional() }, examples: [{ args: {} }], run: (ctx, a) => { const jobs = host(ctx, 'exportJobs')(); const sel = a.job ? jobs.filter((j) => j.id === a.job) : jobs; if (a.job && !sel.length) throw new AgentError('JOB_NOT_FOUND', `No export job "${a.job}".`, 'get_export_status with no job lists them.'); return { jobs: sel.map((j) => ({ ...j, path: undefined, file: j.path.split('/').pop() })) }; } }),
    defineAct({ name: 'cancel_export', title: 'Cancel an export', group: 'export', mutates: true, description: 'Stop a queued or running export job (job id from export_video); its partial file is removed.', input: { job: z.string().min(1).max(64) }, examples: [{ args: { job: 'exp_123' } }], describe: () => 'Cancel export', run: async (ctx, a) => ({ cancelled: await host(ctx, 'cancelExport')(a.job) }) }),
    defineAct({ name: 'export_subtitles', title: 'Export subtitles', group: 'export', mutates: true, description: 'Write the captions as an SRT or WebVTT file into the export folder (for platforms that take subtitle files).', input: { format: z.enum(['srt', 'vtt']), fileName: FileName(['srt', 'vtt']).optional() }, examples: [{ args: { format: 'srt' } }], describe: (a) => `Save ${a.format.toUpperCase()} subtitles`, run: async (ctx, a) => { const doc = docOf(ctx); const text = captionsToSubtitles(doc, a.format); const cues = (text.match(/-->/g) ?? []).length; if (!cues) throw new AgentError('NO_CAPTIONS', 'There are no captions to export.', 'generate_captions first.'); const name = a.fileName ?? `${doc.name.replace(/[^\w .-]+/g, '_')}.${a.format}`; if (!name.toLowerCase().endsWith(`.${a.format}`)) throw new AgentError('INVALID_ARGS', `fileName must end in .${a.format}.`, undefined); const path = await host(ctx, 'writeExportFile')(name, 'text', text); return { file: path.split('/').pop(), cues }; } }),
    defineAct({
      name: 'export_chapters', title: 'Export YouTube chapters', group: 'export', mutates: true,
      description: 'Write the chapter markers as a YouTube chapter list ("0:00 Intro" lines, ready to paste into the video description) into the export folder, and return the text. YouTube needs the first chapter at 0:00 (firstTitle names it when no chapter starts there), at least 3 chapters, each at least 10 seconds long; problems lists anything that breaks those rules.',
      input: { fileName: FileName(['txt']).optional(), firstTitle: z.string().min(1).max(100).optional().describe('Title for a 0:00 chapter when no chapter marker starts there (default "Intro")') },
      examples: [{ args: {} }, { args: { fileName: 'chapters.txt', firstTitle: 'Cold open' } }],
      describe: () => 'Save YouTube chapters',
      run: async (ctx, a) => {
        const doc = docOf(ctx);
        const end = timelineDuration(doc);
        const marks = doc.markers.filter((m) => m.kind === 'chapter' && m.t < end).sort((x, y) => x.t - y.t);
        if (!marks.length) throw new AgentError('NO_CHAPTERS', 'There are no chapter markers.', 'Add them with add_marker {"at": seconds, "label": "Title", "kind": "chapter"}.');
        const list = marks.map((m) => ({ t: m.t, title: m.label.trim() || 'Chapter' }));
        if (list[0]!.t >= 1_000_000) list.unshift({ t: 0, title: a.firstTitle ?? 'Intro' });
        else list[0]!.t = 0;
        const long = end >= 3600e6;
        const stamp = (t: number) => { const s = Math.floor(t / 1e6), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0'); return long ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
        const text = list.map((c) => `${stamp(c.t)} ${c.title}`).join('\n') + '\n';
        const problems: string[] = [];
        if (list.length < 3) problems.push(`YouTube needs at least 3 chapters (there are ${list.length}).`);
        list.forEach((c, i) => { const next = list[i + 1]?.t ?? end; if (next - c.t < 10e6) problems.push(`"${c.title}" at ${stamp(c.t)} is shorter than 10 s.`); });
        const name = a.fileName ?? `${doc.name.replace(/[^\w .-]+/g, '_')} chapters.txt`;
        const path = await host(ctx, 'writeExportFile')(name, 'text', text);
        return { file: path.split('/').pop(), chapters: list.length, text, youtubeReady: problems.length === 0, problems };
      },
    }),
    defineAct({ name: 'export_still', title: 'Save a still or cover', group: 'export', mutates: true, description: 'Save a full-resolution PNG of the edit at time t (seconds), for a cover or thumbnail, into the export folder.', input: { t: Seconds, fileName: FileName(['png']).optional() }, examples: [{ args: { t: 1.2, fileName: 'cover.png' } }], describe: (a) => `Save a still at ${a.t} s`, run: async (ctx, a) => { const doc = docOf(ctx); const r = await host(ctx, 'renderFrame')(Math.min(us(a.t), timelineDuration(doc) - 1), doc.canvas.width); const path = await host(ctx, 'writeExportFile')(a.fileName ?? `${doc.name.replace(/[^\w .-]+/g, '_')} cover.png`, 'image', r.png); return { file: path.split('/').pop(), width: r.width, height: r.height }; } }),

    // App, projects and playback
    defineRead({ name: 'get_state', title: 'What the person sees', group: 'app', description: 'The app state: workspace, playhead (s), playing or not, selected clip ids, in and out points (s), the open project folder and the permission mode.', input: {}, examples: [{ args: {} }], run: (ctx) => { const s = host(ctx, 'state')(); const i = host(ctx, 'info')(); return { workspace: s.workspace, playhead: sec(s.playhead), playing: s.playing, selection: s.selection, inPoint: s.inPoint != null ? sec(s.inPoint) : null, outPoint: s.outPoint != null ? sec(s.outPoint) : null, mode: i.mode, project: ctx.getDoc()?.name ?? null, revision: ctx.revision() }; } }),
    defineAct({ name: 'save_project', title: 'Save', group: 'app', description: 'Write the project to disk now (changes autosave continuously anyway).', input: {}, examples: [{ args: {} }], run: async (ctx) => { if (!ctx.getDoc()) throw noProject(); await host(ctx, 'save')(); return { saved: true }; } }),
    defineRead({ name: 'list_projects', title: 'List projects', group: 'app', description: 'Projects on this Mac, most recent first, with folder, name and last change.', input: {}, examples: [{ args: {} }], run: async (ctx) => ({ projects: await host(ctx, 'listProjects')() }) }),
    defineAct({ name: 'open_project', title: 'Open a project', group: 'app', mutates: true, description: 'Open a project by folder (from list_projects) or exact name; it replaces what is open in the window.', input: { project: z.string().min(1).max(4096) }, examples: [{ args: { project: 'Prompting reel' } }], describe: (a) => `Open project ${a.project.split('/').pop()}`, run: async (ctx, a) => { const all = await host(ctx, 'listProjects')(); const hit = all.find((p) => p.dir === a.project) ?? all.find((p) => p.name === a.project); if (!hit) throw new AgentError('PROJECT_NOT_FOUND', `No project "${a.project}".`, 'list_projects shows names and folders.'); const doc = await host(ctx, 'openProject')(hit.dir); return { opened: doc.name, revision: ctx.revision() }; } }),
    defineAct({ name: 'create_project', title: 'New project', group: 'app', mutates: true, description: 'Create and open a new empty project. preset: vertical-1080 (default), landscape-1080, landscape-4k, square-1080, portrait-4x5; fps: 24, 25, 29.97, 30 (default), 50, 59.94, 60.', input: { name: z.string().min(1).max(200), preset: z.string().max(40).optional(), fps: z.string().max(10).optional() }, examples: [{ args: { name: 'Prompting reel' } }], describe: (a) => `Create project ${a.name}`, run: async (ctx, a) => { const doc = await host(ctx, 'createProject')(a.name, a.preset, a.fps); return { created: doc.name, canvas: `${doc.canvas.width}x${doc.canvas.height}`, revision: ctx.revision() }; } }),
    defineAct({ name: 'seek', title: 'Move the playhead', group: 'app', description: 'Move the playhead to t seconds so the person sees that moment in the preview.', input: { t: Seconds }, examples: [{ args: { t: 12.5 } }], run: (ctx, a) => { const doc = docOf(ctx); const t = Math.min(us(a.t), timelineDuration(doc)); host(ctx, 'seek')(t); return { playhead: sec(t) }; } }),
    defineAct({ name: 'play', title: 'Play', group: 'app', description: 'Start playback from the playhead (seek first to choose where).', input: {}, examples: [{ args: {} }], run: async (ctx) => { docOf(ctx); await host(ctx, 'play')(); return { playing: true }; } }),
    defineAct({ name: 'pause', title: 'Pause', group: 'app', description: 'Stop playback; the playhead stays where it stopped (get_state reports it).', input: {}, examples: [{ args: {} }], run: (ctx) => { host(ctx, 'pause')(); return { playing: false }; } }),
    defineAct({ name: 'select_clips', title: 'Select clips', group: 'app', description: 'Select clips in the timeline (empty list clears), to point the person at what you are talking about.', input: { clips: z.array(Ref).max(500) }, examples: [{ args: { clips: ['clip_abc'] } }], run: (ctx, a) => { const doc = docOf(ctx); for (const id of a.clips) clipRef(doc, id); host(ctx, 'select')(a.clips); return { selected: a.clips }; } }),
    defineAct({ name: 'show_workspace', title: 'Switch workspace', group: 'app', description: 'Show a workspace in the window: swipe, script, record, edit or export (the edit tools work whichever is showing).', input: { workspace: z.enum(['swipe', 'script', 'record', 'edit', 'export']) }, examples: [{ args: { workspace: 'edit' } }], run: (ctx, a) => { host(ctx, 'showWorkspace')(a.workspace); return { workspace: a.workspace }; } }),

    // Templates and library
    defineRead({ name: 'list_templates', title: 'Saved templates', group: 'structure', description: 'Templates saved from the Text panel or save_template: id, name, length (s) and how many text slots they have.', input: {}, examples: [{ args: {} }], run: async (ctx) => ({ templates: (await host(ctx, 'templates')()).map((t) => ({ id: t.id, name: t.name, duration: sec(t.duration), textSlots: t.clips.filter((c) => c.placeholder).length, clips: t.clips.length })) }) }),
    defineAct({ name: 'save_template', title: 'Save clips as a template', group: 'structure', mutates: true, description: 'Save clips (titles, shapes, graphics) as a reusable template; their text becomes fill-in slots for apply_template.', input: { clips: z.array(Ref).min(1).max(100), name: z.string().min(1).max(100) }, examples: [{ args: { clips: ['clip_title', 'clip_bar'], name: 'Lower third' } }], describe: (a) => `Save template ${a.name}`, run: async (ctx, a) => { const doc = docOf(ctx); for (const id of a.clips) clipRef(doc, id); const t = makeTemplate(doc, a.clips, a.name); const all = await host(ctx, 'templates')(); await host(ctx, 'saveTemplates')([...all.filter((x) => x.name !== a.name), t]); return { template: t.id, name: t.name }; } }),
    defineRead({ name: 'list_audio_library', title: 'Music and sound effects', group: 'library', description: 'Music and sound effects in the person\'s audio folders: name, kind (music or sfx), length and path. Import one with import_media then add_clip.', input: { kind: z.enum(['music', 'sfx']).optional(), query: z.string().max(100).optional() }, examples: [{ args: { kind: 'music', query: 'upbeat' } }], run: async (ctx, a) => ({ items: (await host(ctx, 'audioLibrary')()).filter((i) => (!a.kind || i.kind === a.kind) && (!a.query || i.name.toLowerCase().includes(a.query.toLowerCase()))).slice(0, 300).map((i) => ({ name: i.name, kind: i.kind, duration: sec(i.durationUs), folder: i.folder.split('/').pop(), path: i.path })) }) }),
    defineRead({ name: 'list_references', title: 'Swipe references', group: 'library', description: 'Reference reels saved in the Swipe library for the active brand: id, title, stats, tags, and pacing if analyzed. query searches titles and notes.', input: { query: z.string().max(200).optional(), tag: z.string().max(64).optional() }, examples: [{ args: {} }], run: async (ctx, a) => { const b = brand(ctx); const refs = await host(ctx, 'library')('swipe.list', b, { q: a.query, tag: a.tag }) as Array<Record<string, unknown>>; return { brand: b, references: refs.slice(0, 200).map((r) => ({ id: r.id, title: r.title, views: r.views, likes: r.likes, tags: r.tags, durationSec: r.durationUs ? sec(r.durationUs as number) : null, pacing: (r.analysis as { pacing?: unknown } | null)?.pacing ?? null })) }; } }),
    defineRead({ name: 'get_reference', title: 'Read a reference', group: 'library', description: 'One Swipe reference: stats, notes, pacing (shots, cuts per minute, words per second), structure labels (hook, setup, payoff, CTA) and transcript, to model an edit on it.', input: { id: z.string().min(1).max(64) }, examples: [{ args: { id: 'ref_123' } }], run: async (ctx, a) => { const b = brand(ctx); const r = await host(ctx, 'library')('swipe.get', b, a.id) as Record<string, unknown> | null; if (!r) throw new AgentError('REFERENCE_NOT_FOUND', `No reference "${a.id}".`, 'list_references shows them.'); const tr = await host(ctx, 'library')('swipe.transcript', b, a.id).catch(() => null); const { path: _p, ...rest } = r; return { ...rest, transcript: tr }; } }),
    defineRead({ name: 'list_scripts', title: 'Scripts', group: 'library', description: 'Scripts in the Script studio for the active brand: id, title, current version, words per minute and target length.', input: {}, examples: [{ args: {} }], run: async (ctx) => { const b = brand(ctx); const s = await host(ctx, 'library')('studio.scripts', b) as Array<{ id: string; title: string; versions: number; current: { n: number; wpm: number; targetSec: number | null; text: string } }>; return { scripts: s.map((x) => ({ id: x.id, title: x.title, version: x.current.n, versions: x.versions, wpm: x.current.wpm, targetSec: x.current.targetSec, words: x.current.text.split(/\s+/).filter(Boolean).length })) }; } }),
    defineRead({ name: 'get_script', title: 'Read a script', group: 'library', description: 'A script\'s current text (with its [CUES]), version, words per minute and target length; version picks an older one.', input: { id: z.string().min(1).max(64), version: z.number().int().min(1).optional() }, examples: [{ args: { id: 'scr_123' } }], run: async (ctx, a) => { const b = brand(ctx); const s = await host(ctx, 'library')('studio.script', b, a.id) as { title: string; current: { n: number; text: string; wpm: number; targetSec: number | null } } | null; if (!s) throw new AgentError('SCRIPT_NOT_FOUND', `No script "${a.id}".`, 'list_scripts shows them.'); if (a.version && a.version !== s.current.n) { const v = (await host(ctx, 'library')('studio.versions', b, a.id) as Array<{ n: number; text: string; wpm: number; targetSec: number | null }>).find((x) => x.n === a.version); if (!v) throw new AgentError('RANGE', `Version ${a.version} does not exist.`, undefined); return { id: a.id, title: s.title, ...v }; } return { id: a.id, title: s.title, ...s.current }; } }),
    defineAct({
      name: 'attach_script', title: 'Attach a script to the project', group: 'library', mutates: true,
      description: 'Link a script (and version) to the open project, so make_reel picks the best take of each line and cues (ZOOM, B-ROLL) become edits.',
      input: { id: z.string().min(1).max(64), version: z.number().int().min(1).optional() },
      examples: [{ args: { id: 'scr_123' } }],
      describe: () => 'Attach script',
      run: async (ctx, a) => {
        docOf(ctx);
        const b = brand(ctx);
        const s = await host(ctx, 'library')('studio.script', b, a.id) as { current: { n: number; text: string } } | null;
        if (!s) throw new AgentError('SCRIPT_NOT_FOUND', `No script "${a.id}".`, 'list_scripts shows them.');
        let v = s.current;
        if (a.version && a.version !== v.n) { const all = await host(ctx, 'library')('studio.versions', b, a.id) as Array<{ n: number; text: string }>; const hit = all.find((x) => x.n === a.version); if (!hit) throw new AgentError('RANGE', `Version ${a.version} does not exist.`, undefined); v = hit; }
        const ops: Op[] = [{ op: 'setMeta', patch: { scriptRef: { scriptId: a.id, version: v.n }, scriptText: v.text } }];
        const revision = ctx.apply(ops, labelFor(ctx, `Attach script v${v.n}`));
        return { attached: a.id, version: v.n, revision };
      },
    }),
  ];
}

function brand(ctx: AgentContext): string {
  const b = ctx.host.activeBrand?.();
  if (!b) throw new AgentError('UNAVAILABLE', 'No brand is active in the Swipe library.', undefined);
  return b;
}
