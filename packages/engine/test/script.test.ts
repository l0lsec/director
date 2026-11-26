import { describe, expect, it } from 'vitest';
import { parseScript, WpmScroller, cuesCrossed, estimateSeconds, tokenize, numberToWords } from '../src';

const TEXT = `[HOOK] Stop typing plain prompts into Claude.
Ask me questions before you answer.
[ZOOM] Give me three options and pick the best one.
[PAUSE]
[B-ROLL: screen recording of the prompt] Write this for a busy owner who reads on their phone.
[CTA] Save this before your next prompt.`;

describe('fixed-speed scrolling', () => {
  it('scrolls within 3 percent of the set WPM over 60 s on a fake clock', () => {
    const long = Array.from({ length: 60 }, (_, i) => `Line ${i} has exactly seven spoken words here.`).join('\n');
    const s = parseScript(long);
    for (const wpm of [120, 160, 184, 220]) {
      const sc = new WpmScroller(s, wpm);
      for (let i = 0; i < 3600; i++) sc.tick(1 / 60); // 60 s at 60 fps
      expect(Math.abs(sc.position - wpm) / wpm).toBeLessThanOrEqual(0.03);
    }
  });

  it('holds at PAUSE cues and stops at the end', () => {
    const s = parseScript(TEXT);
    const sc = new WpmScroller(s, 120, 0.6);
    const pause = s.cues.find((c) => c.kind === 'pause')!;
    let reachedAt = -1;
    let leftAt = -1;
    for (let i = 0; i < 6000; i++) {
      const p = sc.tick(0.01);
      if (reachedAt < 0 && p >= pause.wordIndex) reachedAt = i;
      if (reachedAt >= 0 && leftAt < 0 && p > pause.wordIndex) leftAt = i;
    }
    expect((leftAt - reachedAt) * 0.01).toBeGreaterThanOrEqual(0.6);
    expect(sc.done).toBe(true);
    expect(sc.position).toBe(s.wordCount);
  });
});

describe('script cues', () => {
  it('keeps cues out of the read text and anchors them to word offsets', () => {
    const s = parseScript(TEXT);
    expect(s.words.map((w) => w.text).join(' ')).not.toMatch(/\[|\]|HOOK|B-ROLL|CTA/);
    expect(s.cues.map((c) => [c.kind, c.label])).toEqual([['hook', 'HOOK'], ['zoom', 'ZOOM'], ['pause', 'PAUSE'], ['broll', 'screen recording of the prompt'], ['cta', 'CTA']]);
    const write = s.words.findIndex((w) => w.norm === 'write');
    expect(s.cues[3]!.wordIndex).toBe(write);
    expect(s.cues[0]!.wordIndex).toBe(0);
    expect(s.cues[1]!.wordIndex).toBe(s.words.findIndex((w) => w.norm === 'give'));
  });

  it('emits each cue once as the reader passes it', () => {
    const s = parseScript(TEXT);
    const seen: string[] = [];
    let prev = 0;
    for (let c = 0.5; c <= s.wordCount; c += 0.5) {
      for (const cue of cuesCrossed(s, prev, c)) seen.push(`${cue.kind}@${cue.wordIndex}`);
      prev = c;
    }
    expect(seen).toEqual(s.cues.map((c) => `${c.kind}@${c.wordIndex}`));
    expect(cuesCrossed(s, 10, 5)).toEqual([]);
  });

  it('estimates read time and spells numbers for matching', () => {
    const s = parseScript(TEXT);
    expect(estimateSeconds(s, 180)).toBeCloseTo((s.wordCount / 180) * 60 + 0.6, 5);
    expect(tokenize('Give me 3 options, 25 times')).toEqual(['give', 'me', 'three', 'options', 'twenty', 'five', 'times']);
    expect(numberToWords(1200)).toEqual(['one', 'thousand', 'two', 'hundred']);
  });
});
