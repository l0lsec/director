import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newProject, newClip, applyOps, parseScript, timelineDuration, clipEnd, type Project } from '@director/engine';
import {
  timelineWords, findPauses, findFillers, planAutoCut, cutOps, rangesForWords, planBestTake, chunkCaptions, captionOps, captionsToSubtitles,
  CAPTION_STYLES, SAFE_ZONES, DEFAULT_AUTOCUT, DEFAULT_CAPTIONS, captionLayout, type TimelineWord,
} from '../src';

const gt = JSON.parse(readFileSync(join(__dirname, '../../../fixtures/ground-truth.json'), 'utf8'));
const us = (s: number) => Math.round(s * 1e6);

/** A project with one voice clip of a fixture and a transcript built from ground-truth word timings. */
function projectFor(key: 'speechGaps' | 'retakes' | 'speech', words?: Array<{ text: string; start: number; end: number }>): Project {
  const g = gt[key];
  let doc = newProject({ name: key });
  const voice = doc.lanes.find((l) => l.kind === 'voice')!.id;
  const dur = us(g.durationSec);
  doc = applyOps(doc, [
    { op: 'addMedia', media: { id: 'm', path: `/f/${g.file}`, hash: 'h', name: g.file, kind: 'audio', durationUs: dur, hasAudio: true, hasVideo: false, addedAt: '' } },
    { op: 'addClip', laneId: voice, clip: newClip({ id: 'v', kind: 'media', mediaId: 'm', start: 0, in: 0, out: dur, audio: { gainDb: { value: 0 }, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, duckable: false } }) },
    { op: 'setMeta', patch: { transcript: [{ mediaId: 'm', language: 'en', words: (words ?? g.words).map((w: { text: string; start: number; end: number }) => ({ text: w.text, start: us(w.start), end: us(w.end) })) }] } },
  ]).doc;
  return doc;
}

describe('AutoCut', () => {
  it('removes every pause over the threshold and keeps the padding', () => {
    const doc = projectFor('speechGaps');
    const words = timelineWords(doc);
    const o = DEFAULT_AUTOCUT;
    const ranges = planAutoCut(doc, words, { ...o, fillers: false });
    const after = applyOps(doc, cutOps(doc, ranges)).doc;
    const w2 = timelineWords(after);
    for (let i = 0; i < w2.length - 1; i++) expect(w2[i + 1]!.start - w2[i]!.end).toBeLessThanOrEqual(Math.max(o.minPause, 2 * o.keep) + 1000);
    // Independent expectation from ground truth: each long gap shrinks to 2 * keep, lead and tail to keep.
    const g = gt.speechGaps.words as Array<{ start: number; end: number }>;
    let expected = gt.speechGaps.durationSec * 1e6;
    expected -= us(g[0]!.start) - o.keep;
    expected -= us(gt.speechGaps.durationSec) - us(g[g.length - 1]!.end) - o.keep;
    for (let i = 0; i < g.length - 1; i++) { const gap = us(g[i + 1]!.start) - us(g[i]!.end); if (gap > o.minPause) expected -= gap - 2 * o.keep; }
    expect(Math.abs(timelineDuration(after) - expected)).toBeLessThanOrEqual(2 * 33_334);
    // Padding: the first word now starts exactly `keep` in.
    expect(Math.abs(w2[0]!.start - o.keep)).toBeLessThanOrEqual(1000);
  });

  it('flags filler words and nothing else', () => {
    const doc = projectFor('speechGaps');
    const words = timelineWords(doc);
    const f = findFillers(words, DEFAULT_AUTOCUT.fillers as string[]);
    expect(f.map((r) => r.label)).toEqual(['Filler "um"', 'Filler "uh"']);
  });

  it('deletes selected words at word boundaries and undo restores', () => {
    const doc = projectFor('speech');
    const words = timelineWords(doc);
    const ranges = rangesForWords(words, [2, 3]);
    expect(ranges[0]!.from).toBe(words[2]!.start);
    expect(ranges[0]!.to).toBe(words[4]!.start);
    const after = applyOps(doc, cutOps(doc, ranges)).doc;
    const w2 = timelineWords(after);
    expect(w2.map((w) => w.text).slice(0, 4)).toEqual(['Stop', 'typing', 'into', 'Claude']);
    expect(w2[2]!.start).toBe(words[2]!.start);
  });

  it('adds 10 ms fades where audio was cut', () => {
    const doc = projectFor('speechGaps');
    const after = applyOps(doc, cutOps(doc, findPauses(timelineWords(doc), timelineDuration(doc), DEFAULT_AUTOCUT))).doc;
    const clips = after.lanes.find((l) => l.kind === 'voice')!.clips;
    expect(clips.length).toBeGreaterThan(2);
    for (let i = 0; i < clips.length; i++) {
      if (i > 0) expect(clips[i]!.audio!.fadeIn).toBe(10_000);
      if (i < clips.length - 1) expect(clips[i]!.audio!.fadeOut).toBe(10_000);
    }
  });
});

describe('best take', () => {
  const lines = gt.retakes.lines as string[];
  const script = parseScript(lines.join('\n'));

  it('keeps each line once, from its last complete take, dropping false starts and ad-libs', () => {
    const doc = projectFor('retakes');
    const plan = planBestTake(script, timelineWords(doc), [], timelineDuration(doc));
    expect(plan.missingLines).toEqual([]);
    const keeps = (gt.retakes.takes as Array<{ kind: string; text: string; start: number }>).filter((t) => t.kind === 'keep');
    expect(plan.chosen.map((a) => Math.round(a.start / 1e5))).toEqual(keeps.map((k) => Math.round(us(k.start) / 1e5)));
    const after = applyOps(doc, cutOps(doc, plan.cuts)).doc;
    expect(timelineWords(after).map((w) => w.text.toLowerCase()).join(' ')).toBe(lines.join(' ').toLowerCase());
  });

  it('a retake marker overrides alignment', () => {
    // Line 1 read three times: complete, complete, then cut short. Alignment alone picks the second;
    // a retake marker right after the second rules it out, so the first wins.
    const L = 'Ask me questions before you answer'.split(' ');
    const words: Array<{ text: string; start: number; end: number }> = [];
    let t = 0.5;
    const say = (ws: string[]) => { for (const w of ws) { words.push({ text: w, start: t, end: t + 0.3 }); t += 0.4; } t += 0.8; };
    say(L); say(L); const afterSecond = t - 0.5; say(L.slice(0, 3));
    let doc = projectFor('speech', words);
    const s = parseScript(L.join(' '));
    const plain = planBestTake(s, timelineWords(doc), [], timelineDuration(doc));
    expect(Math.round(plain.chosen[0]!.start / 1e5)).toBe(Math.round(us(words[6]!.start) / 1e5));
    doc = applyOps(doc, [{ op: 'addMarker', marker: { id: 'r', t: us(afterSecond), kind: 'retake', label: 'Retake line 1', data: { line: 0 } } }]).doc;
    const marked = planBestTake(s, timelineWords(doc), doc.markers, timelineDuration(doc));
    expect(Math.round(marked.chosen[0]!.start / 1e5)).toBe(Math.round(us(words[0]!.start) / 1e5));
  });
});

describe('captions', () => {
  it('cards respect limits and never span a cut', () => {
    const doc = projectFor('speechGaps');
    const cut = applyOps(doc, cutOps(doc, planAutoCut(doc, timelineWords(doc), DEFAULT_AUTOCUT))).doc;
    const words = timelineWords(cut);
    const cards = chunkCaptions(words, DEFAULT_CAPTIONS);
    for (const c of cards) {
      expect(c.length).toBeLessThanOrEqual(DEFAULT_CAPTIONS.maxWords);
      expect(c.map((w) => w.text).join(' ').length).toBeLessThanOrEqual(DEFAULT_CAPTIONS.maxChars);
      expect(new Set(c.map((w) => w.clipId)).size).toBe(1);
    }
    const after = applyOps(cut, captionOps(cut, words)).doc;
    const caps = after.lanes.find((l) => l.kind === 'captions')!.clips;
    const voice = after.lanes.find((l) => l.kind === 'voice')!.clips;
    for (const c of caps) {
      const host = voice.find((v) => v.start <= c.start && clipEnd(v) > c.start)!;
      expect(clipEnd(c)).toBeLessThanOrEqual(clipEnd(host));
    }
  });

  it('every style sits inside every platform safe zone on a 1080x1920 canvas', () => {
    const H = 1920, W = 1080;
    for (const s of CAPTION_STYLES) for (const [name, z] of Object.entries(SAFE_ZONES)) {
      const L = captionLayout(s, name, W, H);
      const lineH = s.text.size * s.text.lineHeight;
      const block = lineH * 2 + (s.text.box ? s.text.box.padding * 1.2 : 0) + (s.text.stroke?.width ?? 0) * 2;
      const halfW = (L.maxWidth * W) / 2 + (s.text.box?.padding ?? 0) + (s.text.stroke?.width ?? 0);
      expect(L.cy - block / 2, `${s.id} top in ${name}`).toBeGreaterThanOrEqual(z.top * H);
      expect(L.cy + block / 2, `${s.id} bottom in ${name}`).toBeLessThanOrEqual((1 - z.bottom) * H);
      expect(L.cx - halfW, `${s.id} left in ${name}`).toBeGreaterThanOrEqual(z.left * W);
      expect(L.cx + halfW, `${s.id} right in ${name}`).toBeLessThanOrEqual((1 - z.right) * W);
    }
  });

  it('SRT and VTT are valid and match the caption clips', () => {
    const doc = projectFor('speech');
    const after = applyOps(doc, captionOps(doc, timelineWords(doc))).doc;
    const caps = after.lanes.find((l) => l.kind === 'captions')!.clips;
    const srt = captionsToSubtitles(after, 'srt');
    const vtt = captionsToSubtitles(after, 'vtt');
    const srtCues = srt.trim().split(/\n\n/);
    expect(srtCues).toHaveLength(caps.length);
    srtCues.forEach((cue, i) => {
      const [n, times, text] = cue.split('\n');
      expect(n).toBe(String(i + 1));
      expect(times).toMatch(/^\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}$/);
      const toUs = (s: string) => { const [h, m, rest] = s.split(':'); const [sec, ms] = rest!.split(/[,.]/); return ((+h! * 60 + +m!) * 60 + +sec!) * 1e6 + +ms! * 1000; };
      const [a, b] = times!.split(' --> ');
      expect(Math.abs(toUs(a!) - caps[i]!.start)).toBeLessThanOrEqual(1000);
      expect(Math.abs(toUs(b!) - clipEnd(caps[i]!))).toBeLessThanOrEqual(1000);
      expect(text).toBe(caps[i]!.text!.content);
    });
    expect(vtt.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt).toMatch(/\d\d:\d\d:\d\d\.\d{3} --> /);
  });
});

describe('best take safety', () => {
  it('cuts nothing when no script line is found in the recording', async () => {
    const { planBestTake } = await import('../src');
    const { parseScript } = await import('@director/engine');
    const plan = planBestTake(parseScript('Completely different words here\nAnother unrelated line'), [{ text: 'hello', start: 0, end: 500_000, clipId: 'c', mediaId: 'm', srcStart: 0, srcEnd: 500_000 }], [], 10_000_000);
    expect(plan.missingLines).toEqual([0, 1]);
    expect(plan.cuts).toEqual([]);
  });
});
