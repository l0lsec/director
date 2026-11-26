import { z } from 'zod';
import { normalizeWord, parseOps, applyOps, type Op, type Project } from '@director/engine';
import { DEFAULT_AUTOCUT, DEFAULT_CAPTIONS, DEFAULT_FILLERS, cutOps, planAutoCut, rangesForWords, removedDuration, timelineWords, type TimelineWord } from '@director/analysis';
import { AgentError, defineEdit, describeChanges, planEdit, type PlanEnv, type ToolDef } from '../core';
import { planMakeReel } from '../makereel';
import { sec, us } from '../units';

export function noTranscript(): AgentError {
  return new AgentError('NO_TRANSCRIPT', 'There is no transcript of the speech on the timeline yet.', 'Call transcribe first; it finds the clips with speech by itself.');
}

/** Find a phrase in timeline words; returns word index ranges. Matching ignores case and punctuation. */
export function findPhrase(words: TimelineWord[], phrase: string): Array<{ first: number; last: number }> {
  const want = phrase.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (!want.length) return [];
  const norm = words.map((w) => normalizeWord(w.text));
  const hits: Array<{ first: number; last: number }> = [];
  for (let i = 0; i + want.length <= norm.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) if (norm[i + j] !== want[j]) { ok = false; break; }
    if (ok) hits.push({ first: i, last: i + want.length - 1 });
  }
  return hits;
}

export const transcriptTools = (getTools: () => Map<string, ToolDef>) => [
  defineEdit({
    name: 'cut_words', title: 'Cut words (text-based editing)', group: 'transcript', destructive: true,
    description: 'Remove spoken words from the edit like deleting text: by `text` (a phrase to find; occurrence picks which match, default the first, or "all"), or by word index range (first/last from get_transcript, inclusive), or a list of indices. Picture, sound and captions are cut together (ripple) at word boundaries, with tiny fades so joins do not click.',
    input: {
      text: z.string().min(1).max(2000).optional(),
      occurrence: z.union([z.number().int().min(1).max(1000), z.literal('all')]).optional(),
      first: z.number().int().min(0).optional(), last: z.number().int().min(0).optional(),
      indices: z.array(z.number().int().min(0)).max(5000).optional(),
    },
    examples: [{ args: { text: 'you know' , occurrence: 'all' } }, { args: { first: 12, last: 18 } }],
    plan: (doc, a) => {
      const words = timelineWords(doc);
      if (!words.length) throw noTranscript();
      let idx: number[];
      if (a.text) {
        const hits = findPhrase(words, a.text);
        if (!hits.length) throw new AgentError('TEXT_NOT_FOUND', `"${a.text}" is not in the transcript.`, 'find_in_transcript searches with context; get_transcript shows every word with its index.');
        const pick = a.occurrence === 'all' ? hits : [hits[(a.occurrence ?? 1) - 1]];
        if (!pick[0]) throw new AgentError('RANGE', `"${a.text}" occurs ${hits.length} time(s); occurrence ${a.occurrence} does not exist.`, undefined);
        idx = pick.flatMap((h) => Array.from({ length: h!.last - h!.first + 1 }, (_, k) => h!.first + k));
      } else if (a.first != null && a.last != null) {
        if (a.last < a.first) throw new AgentError('RANGE', '`last` must be at or after `first`.', undefined);
        idx = Array.from({ length: a.last - a.first + 1 }, (_, k) => a.first! + k);
      } else if (a.indices?.length) idx = a.indices;
      else throw new AgentError('INVALID_ARGS', 'Give text, first and last, or indices.', 'For example {"text":"um so"}.');
      const bad = idx.find((i) => i >= words.length);
      if (bad != null) throw new AgentError('RANGE', `Word index ${bad} does not exist (the transcript has ${words.length} words, 0 to ${words.length - 1}).`, 'get_transcript lists word indices.');
      const ranges = rangesForWords(words, idx);
      return { ops: cutOps(doc, ranges), summary: `Cut ${idx.length} word(s): "${ranges.map((r) => r.label).join(' / ').slice(0, 80)}"`, result: { removedSeconds: sec(removedDuration(ranges)), words: idx.length } };
    },
  }),

  defineEdit({
    name: 'auto_cut', title: 'AutoCut pauses and fillers', group: 'transcript', destructive: true,
    description: `Tighten a talking-head edit: shorten pauses longer than minPause seconds (default 0.35), keeping keep seconds (default 0.08) of air at each side; remove filler words (default: ${DEFAULT_FILLERS.join(', ')}; pass false to keep them or your own list); trim silence before the first and after the last word. Use dryRun to see the ranges first. Needs a transcript.`,
    input: { minPause: z.number().min(0.05).max(10).optional(), keep: z.number().min(0).max(1).optional(), fillers: z.union([z.boolean(), z.array(z.string().min(1).max(40)).max(100)]).optional(), trimEnds: z.boolean().optional() },
    examples: [{ args: {}, note: 'Defaults' }, { args: { minPause: 0.5, fillers: false, dryRun: true } }],
    plan: (doc, a) => {
      const words = timelineWords(doc);
      if (!words.length) throw noTranscript();
      const o = { minPause: us(a.minPause ?? DEFAULT_AUTOCUT.minPause / 1e6), keep: us(a.keep ?? DEFAULT_AUTOCUT.keep / 1e6), fillers: a.fillers === false ? false as const : Array.isArray(a.fillers) ? a.fillers : DEFAULT_FILLERS, trimEnds: a.trimEnds ?? true };
      const ranges = planAutoCut(doc, words, o);
      return {
        ops: cutOps(doc, ranges),
        summary: `AutoCut: ${ranges.length} cut(s), ${sec(removedDuration(ranges))} s`,
        result: { cuts: ranges.map((r) => ({ from: sec(r.from), to: sec(r.to), reason: r.reason, label: r.label })), removedSeconds: sec(removedDuration(ranges)) },
        preview: ranges.slice(0, 50).map((r) => `${r.label} (${sec(r.from)} to ${sec(r.to)} s)`),
      };
    },
  }),

  defineEdit({
    name: 'make_reel', title: 'Make Reel (one-click rough cut)', group: 'transcript', destructive: true,
    description: 'The whole automatic pass in one undo step: vertical 1080x1920, keep the best take of each script line (when a script is attached), AutoCut pauses and fillers, turn ZOOM and B-ROLL cues into punch-ins and placeholders, then captions. Needs a transcript. Good first pass; refine with the other tools.',
    input: { captionStyle: z.enum(['word-pop', 'karaoke', 'boxed', 'clean', 'bold-yellow']).optional() },
    examples: [{ args: {} }, { args: { captionStyle: 'boxed', dryRun: true } }],
    plan: (doc, a) => {
      if (!timelineWords(doc).length) throw noTranscript();
      const { ops, report } = planMakeReel(doc, a.captionStyle ?? doc.settings.captionStyleId ?? DEFAULT_CAPTIONS.styleId);
      return { ops, summary: `Make Reel: ${sec(report.removedUs)} s removed, ${report.captions} captions, ${report.zooms} zooms`, result: { removedSeconds: sec(report.removedUs), bestTakeCuts: report.bestTakeCuts, autoCuts: report.autoCuts, zooms: report.zooms, brollPlaceholders: report.brolls, captions: report.captions, scriptLinesNotFound: report.missingLines, lengthBefore: sec(report.before), lengthAfter: sec(report.after) } };
    },
  }),

  defineEdit({
    name: 'apply_ops', title: 'Apply primitive ops (advanced)', group: 'history',
    description: 'Escape hatch: apply primitive project ops exactly as stored in the project file (addClip, updateClip, removeClip, moveClipToLane, addLane, updateLane, removeLane, moveLane, addMarker, updateMarker, removeMarker, addMedia, updateMedia, removeMedia, setCanvas, setMeta). Times here are MICROSECONDS, unlike every other tool. Prefer the named tools; use this only for something they cannot express.',
    input: { ops: z.array(z.unknown()).min(1).max(5000), summary: z.string().min(1).max(200) },
    examples: [{ args: { summary: 'Rename', ops: [{ op: 'setMeta', patch: { name: 'Final cut' } }] } }],
    plan: (doc, a) => {
      const parsed = parseOps(a.ops);
      if (!parsed.ok) throw new AgentError('INVALID_OPS', `Invalid ops: ${parsed.errors.slice(0, 5).join('; ')}`, 'Op shapes follow the project file format; times are microseconds.');
      return { ops: parsed.ops, summary: a.summary };
    },
  }),

  defineEdit({
    name: 'batch', title: 'Several edits as one step', group: 'history',
    description: 'Run several edit tools in order as ONE atomic change (one undo step, one approval). Each step sees the result of the steps before it, so later steps can use ids created earlier only if you know them in advance; steps that return new ids (add_text, split...) are best followed by a fresh read. If any step fails, nothing is changed and the error names the step. Read and app tools cannot be batched.',
    input: { label: z.string().min(1).max(200).describe('What the batch does, shown to the person and in undo'), steps: z.array(z.object({ tool: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).optional() })).min(1).max(200) },
    examples: [{ args: { label: 'Grade and title the hook', steps: [{ tool: 'add_effect', args: { clips: ['clip_abc'], type: 'color', params: { contrast: 0.2 } } }, { tool: 'add_text', args: { text: 'Watch this', start: 0, duration: 2 } }] } }],
    plan: (doc, a, env) => planBatch(getTools(), doc, a.steps, env, a.label),
  }),
];

export function planBatch(tools: Map<string, ToolDef>, doc: Project, steps: Array<{ tool: string; args?: Record<string, unknown> }>, env: PlanEnv, label: string) {
  let cur = doc;
  const ops: Op[] = [];
  const results: unknown[] = [];
  steps.forEach((s, i) => {
    const t = tools.get(s.tool);
    const where = `Step ${i + 1} (${s.tool})`;
    if (!t) throw new AgentError('UNKNOWN_TOOL', `${where}: there is no tool called ${s.tool}. Nothing was changed.`, 'get_started lists tools.');
    if (t.access !== 'edit' || t.name === 'batch') throw new AgentError('NOT_BATCHABLE', `${where}: ${s.tool} is not an edit tool, so it cannot be batched. Nothing was changed.`, 'Call it on its own before or after the batch.');
    const args = { ...(s.args ?? {}) };
    delete args.dryRun; delete args.expectRevision;
    const parsed = t.input.safeParse(args);
    if (!parsed.success) throw new AgentError('INVALID_ARGS', `${where}: ${parsed.error.issues.slice(0, 4).map((x) => `${x.path.join('.') || '(arguments)'}: ${x.message}`).join('; ')}. Nothing was changed.`, `describe_tool {"name":"${s.tool}"} shows the schema.`);
    try {
      const { plan, after } = planEdit(t, cur, parsed.data, env);
      ops.push(...plan.ops);
      results.push({ step: i + 1, tool: s.tool, summary: plan.summary, ...(plan.result ? { result: plan.result } : {}) });
      cur = after;
    } catch (e) {
      const err = e as AgentError;
      throw new AgentError(err.code ?? 'FAILED', `${where} failed: ${err.message} Nothing was changed.`, err.hint);
    }
  });
  void applyOps;
  return { ops, summary: label, result: { steps: results, changes: describeChanges(doc, cur) } };
}
