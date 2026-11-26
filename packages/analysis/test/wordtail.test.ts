import { describe, it, expect } from 'vitest';
import { wordsFromDtw } from '../src';

describe('word timing from DTW and audio', () => {
  it('a word ended a few frames before its voice does not swallow the next pause (large-v3-turbo case)', () => {
    // Voice 0.00-1.00 s, silence 1.00-1.70 s, voice 1.70-2.20 s (10 ms frames).
    const energy = new Float32Array(260);
    for (let f = 0; f < 100; f++) energy[f] = 0.3;
    for (let f = 170; f < 220; f++) energy[f] = 0.3;
    // DTW puts the first word's end at 0.92 s (inside its voice) and the second word's end at 2.10 s.
    const json = { transcription: [{ tokens: [
      { text: ' answer', t_dtw: 92, offsets: { from: 0, to: 1000 }, p: 0.9 },
      { text: ' give', t_dtw: 210, offsets: { from: 1100, to: 1500 }, p: 0.9 },
    ] }] };
    const [a, b] = wordsFromDtw(json, energy);
    expect(b!.start).toBe(1_700_000);
    expect(b!.start - a!.end).toBeGreaterThanOrEqual(600_000);
    expect(a!.end).toBeGreaterThanOrEqual(980_000);
  });
});
