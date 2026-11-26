/**
 * Script model shared by the prompter, the aligner and the editor.
 * Cues are bracketed tags such as [HOOK], [ZOOM], [PAUSE], [B-ROLL: screen recording], [CTA].
 * They are never read aloud; they become markers with word offsets.
 */
export type CueKind = 'hook' | 'zoom' | 'pause' | 'broll' | 'screen' | 'cta' | 'emphasis' | 'note';

export interface ScriptCue { kind: CueKind; label: string; raw: string; wordIndex: number; line: number }
export interface ScriptWord { text: string; norm: string; line: number; index: number }
export interface ScriptLine { index: number; text: string; firstWord: number; wordCount: number; cues: ScriptCue[] }
export interface ParsedScript { words: ScriptWord[]; lines: ScriptLine[]; cues: ScriptCue[]; wordCount: number }

const CUE_KINDS: Record<string, CueKind> = {
  HOOK: 'hook', ZOOM: 'zoom', PAUSE: 'pause', 'B-ROLL': 'broll', BROLL: 'broll', 'B ROLL': 'broll', SCREEN: 'screen', CTA: 'cta',
  EMPHASIS: 'emphasis', PUNCH: 'zoom', NOTE: 'note',
};

export function normalizeWord(w: string): string {
  return w
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Spell out 0..999999 so "3" from a recognizer matches "three" in a script. */
export function numberToWords(n: number): string[] {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) return [String(n)];
  if (n < 20) return [ONES[n]!];
  if (n < 100) return n % 10 ? [TENS[Math.floor(n / 10)]!, ONES[n % 10]!] : [TENS[n / 10]!];
  if (n < 1000) return [ONES[Math.floor(n / 100)]!, 'hundred', ...(n % 100 ? numberToWords(n % 100) : [])];
  return [...numberToWords(Math.floor(n / 1000)), 'thousand', ...(n % 1000 ? numberToWords(n % 1000) : [])];
}

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\s,;:!?]+/)) {
    const w = normalizeWord(raw);
    if (!w) continue;
    if (/^\d+$/.test(w)) out.push(...numberToWords(Number(w)));
    else out.push(w);
  }
  return out;
}

export function parseCue(raw: string): { kind: CueKind; label: string } {
  const inner = raw.replace(/^\[|\]$/g, '').trim();
  const [head, ...rest] = inner.split(':');
  const key = (head ?? '').trim().toUpperCase();
  const kind = CUE_KINDS[key] ?? 'note';
  return { kind, label: (rest.join(':').trim() || (head ?? '').trim()) };
}

/** Parse script text into spoken words (with line numbers) and cues anchored to the next spoken word. */
export function parseScript(text: string): ParsedScript {
  const words: ScriptWord[] = [];
  const lines: ScriptLine[] = [];
  const cues: ScriptCue[] = [];
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const line: ScriptLine = { index: lines.length, text: '', firstWord: words.length, wordCount: 0, cues: [] };
    const spoken: string[] = [];
    const re = /\[[^\]]*\]|[^\s[]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed))) {
      const tok = m[0];
      if (tok.startsWith('[')) {
        const { kind, label } = parseCue(tok);
        const cue: ScriptCue = { kind, label, raw: tok, wordIndex: words.length, line: line.index };
        cues.push(cue);
        line.cues.push(cue);
        continue;
      }
      const norm = normalizeWord(tok);
      spoken.push(tok);
      if (!norm) continue;
      words.push({ text: tok, norm, line: line.index, index: words.length });
    }
    line.text = spoken.join(' ');
    line.wordCount = words.length - line.firstWord;
    if (line.wordCount > 0 || line.cues.length) lines.push(line);
  }
  return { words, lines, cues, wordCount: words.length };
}

/** Estimated read time in seconds at a words-per-minute rate, counting PAUSE cues as 0.6 s. */
export function estimateSeconds(script: ParsedScript, wpm: number): number {
  const pauses = script.cues.filter((c) => c.kind === 'pause').length;
  return (script.wordCount / Math.max(60, wpm)) * 60 + pauses * 0.6;
}

/**
 * Fixed-speed scrolling. Position is a fractional word index; PAUSE cues hold for `pauseSeconds`
 * when reached. Pure and clock-agnostic so it can be tested with a fake clock.
 */
export class WpmScroller {
  position = 0;
  private hold = 0;
  private passedPauses = new Set<number>();
  private script: ParsedScript;
  public wpm: number;
  private pauseSeconds: number;
  constructor(script: ParsedScript, wpm: number, pauseSeconds = 0.6) { this.script = script; this.wpm = wpm; this.pauseSeconds = pauseSeconds;}

  tick(dtSeconds: number): number {
    let dt = Math.max(0, dtSeconds);
    if (this.hold > 0) { const used = Math.min(this.hold, dt); this.hold -= used; dt -= used; }
    if (dt <= 0) return this.position;
    const rate = Math.max(30, this.wpm) / 60;
    const target = Math.min(this.script.wordCount, this.position + rate * dt);
    for (const c of this.script.cues) {
      if (c.kind !== 'pause' || this.passedPauses.has(c.wordIndex)) continue;
      if (c.wordIndex > this.position && c.wordIndex <= target) {
        this.passedPauses.add(c.wordIndex);
        const used = (c.wordIndex - this.position) / rate;
        this.position = c.wordIndex;
        this.hold = this.pauseSeconds;
        return this.tick(dt - used);
      }
    }
    this.position = target;
    return this.position;
  }

  seekWord(i: number): void { this.position = Math.max(0, Math.min(this.script.wordCount, i)); this.hold = 0; }
  get done(): boolean { return this.position >= this.script.wordCount; }
}

/** Cues the reader passed when the cursor moved from `prev` to `next` (forward only). */
export function cuesCrossed(script: ParsedScript, prev: number, next: number): ScriptCue[] {
  if (next <= prev) return [];
  return script.cues.filter((c) => c.wordIndex >= Math.ceil(prev) && c.wordIndex < Math.floor(next) + (Math.floor(next) === next ? 0 : 1) && c.wordIndex <= next);
}
