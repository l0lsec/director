import { tokenize, type ParsedScript } from '@director/engine';
import { tokenSimilarity } from './similarity';

export interface AlignerOptions {
  /** How many of the most recent spoken tokens are matched against the script. */
  window?: number;
  /** How far ahead (in words) a normal advance may reach, beyond the current line. */
  lookahead?: number;
}

export interface AlignerState { cursor: number; line: number; confidence: number; jumpedBack: boolean }

/**
 * Forward-biased script follower. `cursor` is the index of the next word to be read.
 * Feed it the recognizer's running transcript (any amount of history); it only looks at the tail.
 */
export class ScriptAligner {
  cursor = 0;
  private readonly norms: string[];
  private readonly lineOf: number[];
  private readonly lineStart: number[];
  private readonly window: number;
  private readonly lookahead: number;
  private lastTail = '';

  private script: ParsedScript;
  constructor(script: ParsedScript, opts: AlignerOptions = {}) { this.script = script;
    this.norms = script.words.map((w) => w.norm);
    this.lineOf = script.words.map((w) => w.line);
    this.lineStart = script.lines.map((l) => l.firstWord);
    this.window = opts.window ?? 4;
    this.lookahead = opts.lookahead ?? 12;
  }

  /** Script line of word index i. */
  lineAt(i: number): number { return this.lineOf[Math.min(Math.max(i, 0), this.norms.length - 1)] ?? 0; }
  get wordCount(): number { return this.norms.length; }

  get line(): number {
    if (this.norms.length === 0) return 0;
    return this.lineOf[Math.min(this.cursor, this.norms.length - 1)] ?? 0;
  }

  reset(to = 0): void { this.cursor = Math.max(0, Math.min(to, this.norms.length)); this.lastTail = ''; }

  /** Jump to the start of a line (manual control, retake hotkey). */
  jumpToLine(line: number): void { this.reset(this.lineStart[Math.max(0, Math.min(line, this.lineStart.length - 1))] ?? 0); }

  /**
   * Score how well the spoken tail matches the script ending at position `end` (inclusive).
   * Returns weighted matches; the newest spoken token counts most.
   */
  private scoreAt(tail: string[], end: number): { score: number; matched: number; lastMatched: boolean } {
    let score = 0;
    let matched = 0;
    let lastMatched = false;
    let si = end;
    // Walk backwards through the tail allowing one skipped or inserted word.
    for (let ti = tail.length - 1; ti >= 0 && si >= 0; ti--) {
      const w = 1 + (ti - (tail.length - 1)) * 0.15; // newest 1.0, older a bit less
      let sim = tokenSimilarity(tail[ti]!, this.norms[si]!);
      if (sim === 0 && si - 1 >= 0) {
        const skip = tokenSimilarity(tail[ti]!, this.norms[si - 1]!); // speaker skipped a script word
        if (skip > 0) { si -= 1; sim = skip * 0.8; }
      }
      if (sim > 0) {
        score += sim * w;
        matched++;
        if (ti === tail.length - 1) lastMatched = true;
        si--;
      } else if (ti === tail.length - 1) {
        // The newest token is not in the script here: likely an ad-lib, keep comparing without consuming script.
        continue;
      } else {
        si--;
      }
    }
    return { score, matched, lastMatched };
  }

  /** Update from the recognizer's text. Returns the new state. */
  update(spokenText: string | string[]): AlignerState {
    const tokens = Array.isArray(spokenText) ? spokenText : tokenize(spokenText);
    const tail = tokens.slice(-this.window);
    const key = tail.join(' ');
    if (!tail.length || key === this.lastTail || this.norms.length === 0) return { cursor: this.cursor, line: this.line, confidence: 0, jumpedBack: false };
    this.lastTail = key;

    const n = this.norms.length;
    const curLine = this.line;

    // Fast path: the newest token is the next expected word (or a partial of it, as live recognizers
    // emit "promp" before "prompts"), and the token before it agrees with what was just read.
    const newest = tail[tail.length - 1]!;
    const expected = this.norms[this.cursor];
    if (expected) {
      const exact = tokenSimilarity(newest, expected) >= 0.85;
      const prefix = newest.length >= 3 && expected.length > newest.length && expected.startsWith(newest);
      const prevTok = tail[tail.length - 2];
      const prevOk = this.cursor === 0 || !prevTok || tokenSimilarity(prevTok, this.norms[this.cursor - 1]!) > 0 || (this.lineStart.includes(this.cursor) && tail.length < 3);
      if ((exact || prefix) && prevOk) {
        this.cursor += 1;
        return { cursor: this.cursor, line: this.line, confidence: 1, jumpedBack: false };
      }
    }
    // End of the next line that has spoken words (cue-only lines such as [PAUSE] have none).
    const nextLineEnd = (() => {
      let i = this.cursor;
      while (i < n && this.lineOf[i]! <= curLine) i++;
      if (i >= n) return n - 1;
      const following = this.lineOf[i]!;
      while (i < n && this.lineOf[i]! <= following) i++;
      return i - 1;
    })();
    // Forward search: from just behind the cursor up to the end of the next line (never further).
    const fwdLo = Math.max(0, this.cursor - 2);
    const fwdHi = Math.min(n - 1, Math.min(this.cursor + this.lookahead, nextLineEnd));
    let best = { end: -1, score: 0, matched: 0, lastMatched: false };
    for (let end = fwdLo; end <= fwdHi; end++) {
      const s = this.scoreAt(tail, end);
      const distance = Math.abs(end + 1 - this.cursor);
      const adjusted = s.score - distance * 0.04;
      if (s.lastMatched && adjusted > best.score) best = { end, score: adjusted, matched: s.matched, lastMatched: true };
    }
    const need = Math.min(tail.length, tail.length >= 3 ? 2 : 1);
    if (best.end >= 0 && best.matched >= need && best.score >= need * 0.75) {
      const next = best.end + 1;
      if (next >= this.cursor) {
        this.cursor = next;
        return { cursor: this.cursor, line: this.line, confidence: best.score / tail.length, jumpedBack: false };
      }
      if (next >= this.cursor - 2) return { cursor: this.cursor, line: this.line, confidence: best.score / tail.length, jumpedBack: false };
    }

    // Fast retake: the last two tokens are exactly the first two words of an earlier line,
    // and the newest token does not continue the current position.
    if (tail.length >= 2) {
      const a = tail[tail.length - 2]!;
      const b = tail[tail.length - 1]!;
      const forwardHas = this.norms.slice(this.cursor, this.cursor + 3).includes(b);
      if (!forwardHas) {
        for (let li = this.lineStart.length - 1; li >= 0; li--) {
          const first = this.lineStart[li]!;
          if (first + 2 > this.cursor - 1) continue;
          if (this.norms[first] === a && this.norms[first + 1] === b && a.length + b.length >= 6) {
            this.cursor = first + 2;
            return { cursor: this.cursor, line: this.line, confidence: 0.9, jumpedBack: true };
          }
        }
      }
    }

    // Retake search: the speaker went back to an earlier line. Demand strong evidence.
    if (tail.length >= 3) {
      let back = { end: -1, score: 0, matched: 0 };
      for (let end = 0; end < Math.max(0, this.cursor - 2); end++) {
        const s = this.scoreAt(tail, end);
        if (!s.lastMatched) continue;
        const lineFirst = this.lineStart[this.lineOf[end]!] ?? 0;
        const nearLineStart = end - lineFirst < 6 ? 0.3 : 0;
        const adjusted = s.score + nearLineStart - (this.cursor - end) * 0.002;
        if (s.matched >= 3 && adjusted > back.score) back = { end, score: adjusted, matched: s.matched };
      }
      // Three clean matches weigh 1 + 0.85 + 0.7 = 2.55; re-reads from a line start get a bonus.
      if (back.end >= 0 && back.score >= 2.4) {
        this.cursor = back.end + 1;
        return { cursor: this.cursor, line: this.line, confidence: back.score / tail.length, jumpedBack: true };
      }
    }
    return { cursor: this.cursor, line: this.line, confidence: 0, jumpedBack: false };
  }
}
