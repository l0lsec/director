import { tokenize, type ParsedScript } from '@director/engine';
import { ScriptAligner, type AlignerState } from './aligner';

export interface SpeechEvent { type: 'ready' | 'partial' | 'final' | 'done' | 'installing' | 'level'; text?: string; start?: number; end?: number; wall?: number; rms?: number; t?: number }

export interface FollowState { cursor: number; confirmed: number; line: number; jumpedBack: boolean; predicted: boolean }

/**
 * Turns the recognizer's stream (volatile partials replaced by finals) into a running transcript,
 * drives the aligner, and smooths the display cursor:
 *  - while speech is active, it advances one word past the last confirmed word at the speaker's pace
 *    (recognition arrives a few hundred ms late), never across a line break;
 *  - an unconfirmed prediction is withdrawn once the speaker goes quiet.
 * All times are seconds on one clock supplied by the caller.
 */
export class SpeechFollower {
  readonly aligner: ScriptAligner;
  private committed: string[] = [];
  private volatile: string[] = [];
  private display = 0;
  private lastConfirmAt = -1;
  private secPerWord = 0.4;
  private lastSpeechAt = -10;
  private noiseFloor = 0.004;
  private predictedAt = -1;
  private onsetAt = -1;
  private onsetCursor = 0;
  private opts: { predict?: boolean };
  constructor(script: ParsedScript, opts: { predict?: boolean } = {}) { this.opts = opts; this.aligner = new ScriptAligner(script); }

  get transcript(): string[] { return [...this.committed, ...this.volatile]; }
  get cursor(): number { return this.display; }

  private state(jumpedBack = false): FollowState {
    return { cursor: this.display, confirmed: this.aligner.cursor, line: this.aligner.lineAt(Math.max(0, this.display - (this.display >= this.aligner.wordCount ? 1 : 0))), jumpedBack, predicted: this.display > this.aligner.cursor };
  }

  /** Feed one recognizer event. `now` is the time the event was received. */
  push(e: SpeechEvent, now: number): FollowState | null {
    if (e.type === 'level') return this.level(e.rms ?? 0, now);
    if (e.type === 'partial') this.volatile = tokenize(e.text ?? '');
    else if (e.type === 'final') { this.committed.push(...tokenize(e.text ?? '')); this.volatile = []; if (this.committed.length > 200) this.committed = this.committed.slice(-100); }
    else return null;
    const before = this.aligner.cursor;
    const st: AlignerState = this.aligner.update(this.transcript);
    if (st.jumpedBack) { this.display = st.cursor; this.lastConfirmAt = now; this.predictedAt = -1; return this.state(true); }
    if (st.cursor > before) {
      const steps = st.cursor - before;
      if (this.lastConfirmAt >= 0) {
        const per = (now - this.lastConfirmAt) / steps;
        if (per > 0.12 && per < 0.9) this.secPerWord = this.secPerWord * 0.7 + per * 0.3;
      }
      this.lastConfirmAt = now;
      // Keep a still-valid prediction (display one ahead), otherwise snap to the confirmed cursor.
      // Keep a still-valid prediction (display ahead by at most two), otherwise snap to the confirmed cursor.
      this.display = this.display > st.cursor && this.display - st.cursor <= 2 && this.predictedAt >= 0 ? this.display : st.cursor;
      if (this.display === st.cursor) this.predictedAt = -1;
      // Catch up: recognition of a line's first words arrives late; the time spoken since speech onset
      // says how far the reader really is. Stay within the line and at most two words ahead.
      if (this.onsetAt >= 0 && now - this.lastSpeechAt < 0.12) {
        const spoken = Math.floor((now - this.onsetAt) / this.secPerWord);
        const target = Math.min(this.onsetCursor + spoken, st.cursor + 2);
        let d = this.display;
        while (d < target && d < this.aligner.wordCount && this.aligner.lineAt(d) === this.aligner.lineAt(st.cursor - 1)) d++;
        if (d > this.display) { this.display = d; this.predictedAt = now; }
      }
    }
    return this.state();
  }

  /** Audio level tick (also the prediction clock). */
  level(rms: number, now: number): FollowState {
    if (rms < this.noiseFloor * 2) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
    const speaking = rms > Math.max(0.012, this.noiseFloor * 4);
    if (speaking) {
      if (now - this.lastSpeechAt > 0.3) { this.onsetAt = now; this.onsetCursor = this.aligner.cursor; }
      this.lastSpeechAt = now;
    }
    if (this.opts.predict === false) return this.state();
    const confirmed = this.aligner.cursor;
    if (this.display > confirmed && now - this.lastSpeechAt > 0.35 && now - this.predictedAt > 0.5) {
      // Withdraw a prediction if the speaker went quiet and recognition never confirmed it.
      this.display = confirmed;
      this.predictedAt = -1;
      return this.state();
    }
    const n = this.aligner.wordCount;
    if (confirmed === 0 || this.lastConfirmAt < 0) return this.state();
    const next = this.display; // index of the word the display would mark as read next
    if (next >= n || next - confirmed >= 2) return this.state();
    const sameLine = this.aligner.lineAt(next) === this.aligner.lineAt(confirmed - 1);
    const recentSpeech = now - this.lastSpeechAt < 0.12;
    const since = Math.max(this.lastConfirmAt, this.predictedAt);
    const wait = next === confirmed ? this.secPerWord * 0.5 : this.secPerWord * 0.9;
    if (sameLine && recentSpeech && now - since >= wait) {
      this.display = next + 1;
      this.predictedAt = now;
    }
    return this.state();
  }

  /** Manual retake: jump the prompter to a line and forget what was heard. */
  retakeLine(line: number): void { this.aligner.jumpToLine(line); this.display = this.aligner.cursor; this.committed = []; this.volatile = []; this.predictedAt = -1; this.lastConfirmAt = -1; }
}
