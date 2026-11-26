import { describe, expect, it } from 'vitest';
import { parseScript, tokenize } from '@director/engine';
import { ScriptAligner } from '../src';

const SCRIPT = `[HOOK] Stop typing plain prompts into Claude.
Ask me questions before you answer.
[ZOOM] Give me three options and pick the best one.
Write this for a busy owner who reads on their phone.
Critique your answer like a tough editor, then rewrite it.
[PAUSE]
Save this before your next prompt, and follow for more.
Most people never ask the right question first.
That one habit changes the whole answer.
[CTA] Comment STUDIO and I will send you the full breakdown.`;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const MISHEAR: Record<string, string> = { claude: 'cloud', prompts: 'prompt', questions: 'question', options: 'option', editor: 'editors', breakdown: 'break', owner: 'honor', habit: 'habits' };
const ADLIBS = ['honestly this changed everything for me', 'you know what I mean', 'trust me on this one', 'okay so listen'];

interface Event { token: string; truth: number } // truth = script position after this token (cursor)

/** Simulate what a recognizer hears while someone reads the script imperfectly. */
function simulate(seed: number) {
  const r = rng(seed);
  const s = parseScript(SCRIPT);
  const events: Event[] = [];
  let maxTruth = 0;
  for (const line of s.lines) {
    if (line.wordCount === 0) continue;
    const readLine = (truncateAt?: number) => {
      const end = truncateAt ?? line.wordCount;
      for (let k = 0; k < end; k++) {
        const w = s.words[line.firstWord + k]!;
        const roll = r();
        if (roll < 0.05) continue; // skipped word
        const token = roll < 0.12 && MISHEAR[w.norm] ? MISHEAR[w.norm]! : w.norm;
        events.push({ token, truth: w.index + 1 });
        maxTruth = Math.max(maxTruth, w.index + 1);
      }
    };
    if (r() < 0.15) {
      readLine(Math.max(2, Math.floor(line.wordCount / 2))); // false start
      readLine(); // retake from the line start
    } else {
      readLine();
    }
    if (r() < 0.2) for (const t of tokenize(ADLIBS[Math.floor(r() * ADLIBS.length)]!)) events.push({ token: t, truth: events[events.length - 1]?.truth ?? 0 });
    if (r() < 0.1 && line.index > 0) {
      // Re-read the previous line entirely (a full retake), then continue.
      const prev = s.lines[line.index - 1]!;
      for (let k = 0; k < prev.wordCount; k++) events.push({ token: s.words[prev.firstWord + k]!.norm, truth: prev.firstWord + k + 1 });
      for (let k = 0; k < line.wordCount; k++) events.push({ token: s.words[line.firstWord + k]!.norm, truth: line.firstWord + k + 1 });
    }
  }
  return { s, events };
}

describe('script aligner', () => {
  it('follows 50 imperfect read-throughs to the end without jumping more than a line ahead', () => {
    let endedCorrect = 0;
    let maxAhead = 0;
    let lagSum = 0;
    let lagN = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const { s, events } = simulate(seed);
      const a = new ScriptAligner(s);
      const heard: string[] = [];
      let furthest = 0;
      for (const e of events) {
        heard.push(e.token);
        a.update(heard);
        furthest = Math.max(furthest, e.truth);
        // Never ahead of the furthest point actually read by more than one line.
        const furthestLine = s.words[Math.min(furthest, s.wordCount - 1)]!.line;
        expect(a.line).toBeLessThanOrEqual(furthestLine + 1);
        maxAhead = Math.max(maxAhead, a.cursor - furthest);
        lagSum += Math.abs(a.cursor - e.truth);
        lagN++;
      }
      if (a.cursor === s.wordCount || a.cursor >= s.wordCount - 1) endedCorrect++;
    }
    expect(endedCorrect / 50).toBeGreaterThanOrEqual(0.98);
    expect(lagSum / lagN).toBeLessThan(2.5);
    expect(maxAhead).toBeLessThanOrEqual(12);
  });

  it('holds still during silence and ad-libs', () => {
    const s = parseScript(SCRIPT);
    const a = new ScriptAligner(s);
    const heard = tokenize('stop typing plain prompts into claude ask me');
    a.update(heard);
    const at = a.cursor;
    expect(at).toBe(8);
    for (let i = 0; i < 20; i++) a.update(heard); // silence: nothing new
    expect(a.cursor).toBe(at);
    const adlib = [...heard, ...tokenize('honestly this changed everything for me you know what I mean')];
    for (let i = heard.length; i <= adlib.length; i++) a.update(adlib.slice(0, i));
    expect(a.cursor).toBe(at);
  });

  it('jumps back when an earlier line is re-read', () => {
    const s = parseScript(SCRIPT);
    const a = new ScriptAligner(s);
    const read = tokenize('stop typing plain prompts into claude ask me questions before you answer give me three options and pick the best one write this for a busy owner');
    for (let i = 1; i <= read.length; i++) a.update(read.slice(0, i));
    expect(a.line).toBe(3);
    const retake = [...read, ...tokenize('give me three options')];
    let jumpedAt = -1;
    for (let i = read.length + 1; i <= retake.length; i++) { const st = a.update(retake.slice(0, i)); if (st.jumpedBack && jumpedAt < 0) jumpedAt = i - read.length; }
    expect(a.line).toBe(2);
    expect(jumpedAt).toBeGreaterThan(0);
    expect(jumpedAt).toBeLessThanOrEqual(4);
  });

  it('parses cues and keeps them out of the spoken words', () => {
    const s = parseScript(SCRIPT);
    expect(s.cues.map((c) => c.kind)).toEqual(['hook', 'zoom', 'pause', 'cta']);
    expect(s.words.some((w) => w.text.includes('['))).toBe(false);
    expect(s.cues[1]!.wordIndex).toBe(s.lines[2]!.firstWord);
  });
});
