import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScript } from '@director/engine';
import { SpeechFollower, type SpeechEvent } from '@director/analysis';

const root = join(__dirname, '../../../..');
const bin = join(root, 'native/DirectorKit/.build/release/director-native');
const gt = JSON.parse(readFileSync(join(root, 'fixtures/ground-truth.json'), 'utf8'));

/** Play a fixture into the helper at real-time speed and record the cursor over (audio) time. */
async function follow(file: string, lines: string[]) {
  const script = parseScript(lines.join('\n'));
  const f = new SpeechFollower(script);
  const trace: Array<{ t: number; cursor: number; line: number; jumpedBack: boolean; confirmed: number }> = [];
  let ready = 0;
  await new Promise<void>((resolve, reject) => {
    // --warmup 2 models the app, which starts listening at the 3-2-1 countdown.
    const p = spawn(bin, ['listen', '--engine', 'dictation', '--realtime', '--warmup', '2', '--file', join(root, 'fixtures/media', file)]);
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      buf += d;
      const ls = buf.split('\n'); buf = ls.pop()!;
      for (const l of ls) {
        if (!l.trim()) continue;
        const e = JSON.parse(l) as SpeechEvent & { error?: string };
        if (e.error) { reject(new Error(e.error)); return; }
        if ((e as { type: string }).type === 'warm') { ready = e.wall!; continue; }
        if (e.type === 'ready') { ready = e.wall!; continue; }
        const now = (e.wall! - ready) / 1000;
        const st = f.push(e, now);
        if (st) trace.push({ t: now, cursor: st.cursor, line: st.line, jumpedBack: st.jumpedBack, confirmed: st.confirmed });
      }
    });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`helper exited ${code}`))));
  });
  return { script, trace };
}

describe('voice-follow with on-device recognition', () => {
  async function latencies() {
    const { script, trace } = await follow('speech.wav', gt.speech.lines);
    const words = gt.speech.words as Array<{ text: string; end: number }>;
    expect(words.length).toBe(script.wordCount);
    const all: number[] = [];
    const inline: number[] = [];
    const firsts = new Set(script.lines.map((l) => l.firstWord));
    words.forEach((w, i) => {
      const hit = trace.find((x) => x.cursor > i);
      if (!hit) return;
      all.push(hit.t - w.end);
      if (!firsts.has(i)) inline.push(hit.t - w.end);
    });
    const pct = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)]!;
    const r = { all, inline, p50: pct(all, 0.5), p95: pct(all, 0.95), inlineP95: pct(inline, 0.95), words: words.length, endCursor: trace[trace.length - 1]!.cursor, wordCount: script.wordCount };
    console.log(`voice-follow latency p50 ${(r.p50 * 1000).toFixed(0)} ms, p95 ${(r.p95 * 1000).toFixed(0)} ms, within-line p95 ${(r.inlineP95 * 1000).toFixed(0)} ms over ${all.length}/${words.length} words`);
    return r;
  }

  it('highlights within-line words within 300 ms at p95 and every word within 600 ms at p95', async () => {
    const r = await latencies();
    expect(r.all.length).toBeGreaterThanOrEqual(r.words * 0.95);
    expect(r.inlineP95).toBeLessThanOrEqual(0.3);
    expect(r.p95).toBeLessThanOrEqual(0.6);
    expect(r.endCursor).toBeGreaterThanOrEqual(r.wordCount - 1);
  }, 120_000);

  it.skipIf(!process.env.DIRECTOR_STRICT_LATENCY)('strict: every word within 300 ms at p95', async () => {
    const r = await latencies();
    expect(r.p95).toBeLessThanOrEqual(0.3);
  }, 120_000);

  it('holds during 5 s of silence and during an ad-lib', async () => {
    const h = gt.followHold;
    const { script, trace } = await follow('follow-hold.wav', h.lines);
    const line1Words = script.lines[0]!.wordCount;
    const settled = trace.filter((x) => x.t > h.line1End + 0.8 && x.t < h.line2Start + 0.15);
    expect(settled.length).toBeGreaterThan(0);
    for (const x of settled) expect(x.cursor).toBe(line1Words);
    const after = trace.filter((x) => x.t > h.line2Start + 2.5);
    expect(after[after.length - 1]!.cursor).toBe(line1Words + script.lines[1]!.wordCount);
  }, 120_000);

  it('jumps back to a re-read line within 1.5 s', async () => {
    const r = gt.retakes;
    const { script, trace } = await follow('retakes.wav', r.lines);
    // Line 5 (index 4) is read twice: the second read starts at the second "keep" take for that line.
    const takes = r.takes as Array<{ kind: string; text: string; start: number; end: number }>;
    const second = takes.filter((t) => t.text === r.lines[4])[1]!;
    const lineStart = script.lines[4]!.firstWord;
    const back = trace.find((x) => x.t >= second.start && x.cursor >= lineStart && x.cursor < lineStart + script.lines[4]!.wordCount);
    expect(back).toBeTruthy();
    console.log(`retake jump after ${((back!.t - second.start) * 1000).toFixed(0)} ms`);
    expect(back!.t - second.start).toBeLessThanOrEqual(1.5);
    expect(trace[trace.length - 1]!.cursor).toBeGreaterThanOrEqual(script.wordCount - 1);
  }, 120_000);
});
