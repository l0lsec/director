import { describe, it, expect } from 'vitest';
import { applyOps, History, timelineDuration, parseScript, estimateSeconds } from '@director/engine';
import { timelineWords } from '@director/analysis';
import {
  ClaudeClient, ReplayTransport, ClaudeError, PrivacyError, assertTextOnly, privacyFindings, costOf,
  labelStructure, normalizeSegments, tilingProblems, structurePrompt,
  draftScript, writeHooks, checkVoice, releaseCopy, numberedLines,
  compileDirector, runDirector, directorPrompt, mapThroughCuts, timelineSummary,
  type CallRecord, type ClaudeResponse,
} from '../src';
import { responses as R, gt, speechProject, voice } from './helpers';

const S = R.structure as unknown as Record<string, ClaudeResponse>;
const D = R.director as unknown as Record<string, ClaudeResponse>;
const DR = R.draft as unknown as Record<string, ClaudeResponse>;
const client = (rec: Record<string, ClaudeResponse | ClaudeResponse[]>, records: CallRecord[] = []) => {
  const t = new ReplayTransport(rec);
  return { t, c: new ClaudeClient(t, 'claude-opus-5-5', (r) => records.push(r)) };
};
const reel = gt.files['reference-reel.mp4'];
const reelShots = (() => { const cuts = [0, ...reel.cutsAtFrames.map((f: number) => f / 30), 26.83]; return cuts.slice(0, -1).map((s: number, i: number) => ({ start: s, end: cuts[i + 1] })); })();
const reelWords = gt.speech.words as Array<{ text: string; start: number; end: number }>;

describe('structure labels', () => {
  it('parses a recorded response into segments that tile the whole reel', async () => {
    const { c, t } = client({ structure: S.reel! });
    const { structure } = await labelStructure(c, { words: reelWords, shots: reelShots, durationSec: 26.83 });
    expect(tilingProblems(structure.segments, 26.83)).toEqual([]);
    expect(structure.segments.map((s) => s.label)).toEqual(['hook', 'value', 'value', 'value', 'cta']);
    // Boundaries meet at midpoints, snapped to a shot cut within 0.25 s.
    expect(structure.segments.map((s) => +s.start.toFixed(4))).toEqual([0, 4.5, 12.35, 18.5, 22.65]);
    expect(structure.hookType).toBe('pattern interrupt');
    const req = t.log[0]!.request;
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.thinking).toEqual({ type: 'adaptive' });
    expect(req.output_config.effort).toBe('medium');
    expect((req.output_config.format as { type: string }).type).toBe('json_schema');
    expect(req.system[req.system.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(t.log[0]!.json).toContain('[0.50-');
  });
  it('normalizes messy segments (unsorted, out of range, empty, nested) into an exact tiling', async () => {
    const { c } = client({ structure: S.messy! });
    const { structure } = await labelStructure(c, { words: [], shots: [], durationSec: 26.83 });
    expect(tilingProblems(structure.segments, 26.83)).toEqual([]);
    expect(structure.segments.map((s) => s.label)).toEqual(['hook', 'value', 'cta']);
    for (let n = 0; n < 200; n++) {
      // Fuzz: random segments always normalize to a valid tiling.
      const rnd = (k: number) => Math.sin(n * 12.9898 + k * 78.233) * 43758.5453 % 1;
      const segs = Array.from({ length: 1 + (n % 7) }, (_, i) => ({ label: 'value' as const, start: Math.abs(rnd(i)) * 40 - 5, end: Math.abs(rnd(i + 50)) * 40 - 5, summary: '', technique: '' }));
      expect(tilingProblems(normalizeSegments(segs, 30), 30)).toEqual([]);
    }
  });
  it('surfaces refusals, truncation, wrong shapes and non-JSON as typed errors, and still records usage', async () => {
    for (const [k, code] of [['refusal', 'REFUSAL'], ['truncated', 'TRUNCATED'], ['badShape', 'INVALID_OUTPUT'], ['notJson', 'INVALID_OUTPUT']] as const) {
      const records: CallRecord[] = [];
      const { c } = client({ structure: S[k]! }, records);
      const err = await labelStructure(c, { words: reelWords, shots: reelShots, durationSec: 26.83 }).catch((e) => e);
      expect(err).toBeInstanceOf(ClaudeError);
      expect(err.code).toBe(code);
      expect(records.length).toBe(1);
    }
  });
  it('prompt lists phrases with times and shot boundaries', () => {
    const p = structurePrompt(reelWords, reelShots, 26.83);
    expect(p).toContain('Shots: 8.');
    expect(p).toContain('2.00, 4.50, 8.17, 10.00, 13.17, 18.50, 23.00');
    expect(p).toMatch(/\[0\.50-3\.48\] Stop typing plain prompts into Claude/);
  });
});

describe('script studio', () => {
  const reference = { transcript: gt.speech.lines.join('\n'), segments: [{ label: 'hook' as const, start: 0, end: 4.5, summary: 'callout', technique: 'pattern interrupt' }], durationSec: 26.83, hookType: 'pattern interrupt' };
  const within = (sec: number, target: number) => Math.abs(sec - target) / target <= 0.1;
  it('drafts a script within 10% of the target runtime', async () => {
    const { c, t } = client({ draft: DR.fit! });
    const streamed: string[] = [];
    const r = await draftScript(c, { topic: 'editing retention', targetSec: 28, voice, reference }, { onText: (d) => streamed.push(d) });
    const independent = estimateSeconds(parseScript(r.draft.script), voice.wpm);
    expect(r.revisions).toBe(0);
    expect(within(independent, 28)).toBe(true);
    expect(r.estimateSec).toBeCloseTo(independent, 10);
    expect(r.withinTolerance).toBe(true);
    expect(streamed.join('')).toBe(DR.fit!.content.find((b) => b.type === 'text')!.text);
    expect(t.log[0]!.json).toContain('about 75 spoken words');
    expect(t.log[0]!.request.system.length).toBe(2); // system + cached voice context
  });
  it('asks for a revision with the measured count when the first draft runs long', async () => {
    const { c, t } = client({ draft: [DR.long!, DR.revised!] });
    const r = await draftScript(c, { topic: 'editing retention', targetSec: 28, voice, reference });
    expect(r.revisions).toBe(1);
    expect(within(estimateSeconds(parseScript(r.draft.script), voice.wpm), 28)).toBe(true);
    const second = t.log[1]!.request;
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(second.messages[2]!.content[0]!.text).toMatch(/135 spoken words/);
    expect(r.records.length).toBe(2);
  });
  it('reports a draft that is still off target after the revision budget', async () => {
    const { c } = client({ draft: [DR.long!, DR.long!] });
    const r = await draftScript(c, { topic: 'x', targetSec: 28, voice }, { maxRevisions: 1 });
    expect(r.withinTolerance).toBe(false);
    expect(r.revisions).toBe(1);
  });
  it('returns schema-valid, line-level voice findings and drops bad line references', async () => {
    const script = 'Hey guys, welcome back to the channel.\n\nHere is my three second rule.\nLeverage this rule to cut faster.\nThat means the pause before you talk, the um, the restart, all of it, every time.\nFollow for more synergy.';
    const { c, t } = client({ voice: R.voice as unknown as ClaudeResponse });
    const { check } = await checkVoice(c, { script, voice });
    const lines = numberedLines(script);
    expect(lines.length).toBe(5);
    expect(check.dropped).toBe(1);
    for (const f of check.findings) {
      expect(Number.isInteger(f.line) && f.line >= 1 && f.line <= lines.length).toBe(true);
      expect(['info', 'warn', 'fix']).toContain(f.severity);
      expect(f.text).toBe(lines[f.line - 1]);
    }
    expect(check.findings.map((f) => f.line)).toEqual([1, 3, 4, 5]);
    expect(check.findings.find((f) => f.line === 5)!.issue).toMatch(/synergy/); // caught locally
    expect(t.log[0]!.json).toContain('4. That means');
  });
  it('dedupes, clamps and sorts hooks', async () => {
    const { c, t } = client({ hooks: R.hooks as unknown as ClaudeResponse });
    const { hooks } = await writeHooks(c, { topic: 'editing', voice, examples: ['Stop scrolling.'] });
    expect(hooks.length).toBe(10);
    expect(new Set(hooks.map((h) => h.text.toLowerCase())).size).toBe(10);
    expect(Math.max(...hooks.map((h) => h.score))).toBe(10);
    expect(hooks.map((h) => h.score)).toEqual([...hooks.map((h) => h.score)].sort((a, b) => b - a));
    expect(hooks[0]!.tags.every((x) => x === x.toLowerCase())).toBe(true);
    expect(t.log[0]!.request.output_config.effort).toBe('low');
  });
  it('cleans release copy', async () => {
    const { c } = client({ release: R.release as unknown as ClaudeResponse });
    const { copy } = await releaseCopy(c, { transcript: 'hello', voice });
    expect(copy.hashtags).toEqual(['editing', 'videotips', 'reels', 'contentcreator']);
    expect(copy.captions.length).toBe(3);
  });
});

describe('edit director', () => {
  it('rejects invalid and out-of-range actions with reasons and applies nothing', async () => {
    const doc = speechProject();
    const { c } = client({ director: D.invalid! });
    const r = await runDirector(c, doc, { goal: 'tighten' });
    expect(r.plan.ok).toBe(false);
    expect(r.plan.ops).toEqual([]);
    const reasons = r.plan.problems.map((p) => `${p.index}: ${p.reason}`);
    expect(reasons.some((x) => /^0: .*past the end/.test(x))).toBe(true);
    expect(reasons.some((x) => /^1: .*zoom amount 3/.test(x))).toBe(true);
    expect(reasons.some((x) => /^2: .*cut through the word "typing"/.test(x))).toBe(true);
    expect(reasons.some((x) => /^3: .*needs text/.test(x))).toBe(true);
    expect(r.plan.problems.every((p) => p.index !== 4)).toBe(true);
    // An unknown action type fails schema validation before anything is compiled.
    const bad = await runDirector(client({ director: D.badType! }).c, doc, { goal: 'x' }).catch((e) => e);
    expect(bad.code).toBe('INVALID_OUTPUT');
    // Too much cutting is refused as a whole.
    const greedy = compileDirector(doc, [{ type: 'cut', start: 0.3, end: 18.5, text: '', amount: 0, reason: 'too much' }]);
    expect(greedy.ok).toBe(false);
    expect(greedy.problems[0]!.reason).toMatch(/more than 50%/);
  });
  it('applies a valid plan as one transaction with a preview, and undoes in one step', async () => {
    const doc = speechProject();
    const { c } = client({ director: D.valid! });
    const r = await runDirector(c, doc, { goal: 'tighten and add emphasis', targetSec: 24 });
    expect(r.plan.problems).toEqual([]);
    expect(r.plan.ok).toBe(true);
    expect(r.plan.preview.map((p) => p.type)).toEqual(['cut', 'cut', 'cut', 'zoom', 'broll', 'text', 'marker']);
    expect(r.plan.preview.every((p) => p.reason.length > 0)).toBe(true);
    expect(r.plan.removedUs).toBe(3_150_000);
    const h = new History(doc);
    const before = JSON.stringify(doc);
    expect(h.apply(r.plan.ops, 'Director')).not.toBeNull();
    const after = h.doc;
    expect(timelineDuration(after)).toBe(timelineDuration(doc) - 3_150_000);
    const cam = after.lanes.find((l) => l.kind === 'camera')!.clips;
    const zoomClip = cam.find((x) => x.effects.some((e) => e.type === 'zoom'))!;
    const fx = zoomClip.effects.find((e) => e.type === 'zoom')!;
    expect(zoomClip.start + (fx.params.at as number)).toBe(8_420_000 - 1_050_000);
    expect(zoomClip.start + (fx.params.until as number)).toBe(12_230_000 - 1_050_000);
    const broll = after.lanes.find((l) => l.kind === 'broll')!.clips[0]!;
    expect([broll.start, broll.start + broll.out]).toEqual([13_520_000 - 2_100_000, 18_070_000 - 2_100_000]);
    expect(after.lanes.find((l) => l.kind === 'titles')!.clips[0]!.text!.content).toBe('Stop typing plain prompts');
    expect(after.markers.find((m) => m.label === 'Consider a stronger CTA')!.t).toBe(23_430_000 - 3_150_000);
    // Every word survives the cuts (cuts were in pauses only).
    expect(timelineWords(after).length).toBe(timelineWords(doc).length);
    expect(h.undo()!.label).toBe('Director');
    expect(JSON.stringify(h.doc)).toBe(before);
    expect(h.undo()).toBeNull(); // the whole plan was one step
  });
  it('compiles only the actions the user kept', () => {
    const doc = speechProject();
    const actions = JSON.parse(D.valid!.content.find((b) => b.type === 'text')!.text!).actions;
    const keep = compileDirector(doc, actions, new Set([0, 5]));
    expect(keep.ok).toBe(true);
    expect(keep.preview.map((p) => p.index)).toEqual([0, 5]);
    expect(keep.removedUs).toBe(1_050_000);
  });
  it('maps times through ripple cuts', () => {
    const cuts = [{ from: 10, to: 20 }, { from: 30, to: 35 }];
    expect([5, 10, 15, 20, 25, 32, 40].map((t) => mapThroughCuts(t, cuts))).toEqual([5, 10, 10, 10, 15, 20, 25]);
  });
});

describe('privacy guard', () => {
  it('sends only transcript and timeline text: no media bytes, paths or file names', async () => {
    const doc = speechProject();
    const { c, t } = client({ director: D.valid!, structure: S.reel!, voice: R.voice as unknown as ClaudeResponse, draft: DR.fit!, hooks: R.hooks as unknown as ClaudeResponse, release: R.release as unknown as ClaudeResponse });
    await runDirector(c, doc, { goal: 'tighten' });
    await labelStructure(c, { words: reelWords, shots: reelShots, durationSec: 26.83 });
    await checkVoice(c, { script: 'Hello there.', voice });
    await draftScript(c, { topic: 'x', targetSec: 28, voice });
    await writeHooks(c, { topic: 'x', voice, examples: [] });
    await releaseCopy(c, { transcript: 'hi', voice });
    expect(t.log.length).toBe(6);
    for (const { request, json } of t.log) {
      expect(privacyFindings(request)).toEqual([]);
      for (const needle of ['/Users/', 'IMG_0042', '.MOV', '.mp4', 'camera take 3', 'base64', 'image', 'document']) expect(json.includes(needle)).toBe(false);
      for (const m of request.messages) for (const b of m.content) expect(b.type).toBe('text');
    }
    // The Director request carries the transcript and the timeline summary.
    expect(t.log[0]!.json).toContain('Stop typing plain prompts into Claude');
    expect(t.log[0]!.json).toContain('Lane camera: 1 clip(s)');
    expect(timelineSummary(doc)).not.toMatch(/IMG|\.mp4/);
    expect(directorPrompt(doc, timelineWords(doc), { goal: 'x' })).not.toMatch(/Users/);
  });
  it('blocks a request that carries media or paths before the transport sees it (positive controls)', async () => {
    const t = new ReplayTransport({});
    const c = new ClaudeClient(t);
    const big = Buffer.alloc(3000, 7).toString('base64');
    const cases = [
      { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] },
      { messages: [{ role: 'user', content: [{ type: 'text', text: `frame data:image/png;base64,${big}` }] }] },
      { messages: [{ role: 'user', content: [{ type: 'text', text: `bytes ${big}` }] }] },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'open /Users/alex/Movies/take.mov now' }] }] },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'clip IMG_0042.MOV' }] }] },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'raw \u0000\u0001\u0002 bytes' }] }] },
      { messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'text', data: 'x' } }] }] },
    ];
    for (const req of cases) expect(() => assertTextOnly(req as never)).toThrow(PrivacyError);
    const err = await c.call({ task: 'x', system: 's', prompt: 'see /Users/alex/a.mp4', schema: (await import('zod')).z.object({}), effort: 'low' }).catch((e) => e);
    expect(err).toBeInstanceOf(PrivacyError);
    expect(t.log.length).toBe(0);
  });
});

describe('usage meter', () => {
  it('converts recorded usage blocks to dollars with the model price table', async () => {
    // Prices per million tokens, from the claude-api skill model table: input, output, cache read, cache write (5 min).
    const table: Record<string, [number, number, number, number]> = {
      'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-sonnet-5-5': [2, 10, 0.1, 2.5], 'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125],
    };
    const all = [S.reel, S.messy, DR.fit, DR.long, DR.revised, R.hooks, R.voice, R.release, D.valid, D.invalid] as unknown as ClaudeResponse[];
    for (const model of Object.keys(table)) {
      const [i, o, r, w] = table[model]!;
      for (const res of all) {
        const u = res.usage;
        const expected = (u.input_tokens * i + u.output_tokens * o + (u.cache_read_input_tokens ?? 0) * r + (u.cache_creation_input_tokens ?? 0) * w) / 1e6;
        expect(costOf(model, u)).toBeCloseTo(expected, 12);
      }
    }
    expect(costOf('claude-opus-5-5', S.reel!.usage)).toBeCloseTo(0.00736 + 0.01224 + 0.00205, 12);
    expect(costOf('claude-opus-5-5-20261101', { input_tokens: 1e6, output_tokens: 0 })).toBe(4);
    const records: CallRecord[] = [];
    const { c } = client({ director: D.valid! }, records);
    await runDirector(c, speechProject(), { goal: 'x' });
    expect(records[0]!.costUsd).toBeCloseTo((5200 * 4 + 1450 * 20 + 640 * 5) / 1e6, 12);
    expect(records[0]!.task).toBe('director');
  });
});
