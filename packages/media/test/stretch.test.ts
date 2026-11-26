import { describe, expect, it } from 'vitest';
import { timeStretch } from '../src/audio/stretch';

/** Dominant frequency by counting positive-going zero crossings over the middle of the signal. */
function frequency(x: Float32Array, rate: number): number {
  const a = Math.floor(x.length * 0.1), b = Math.floor(x.length * 0.9);
  let crossings = 0, first = -1, last = -1;
  for (let i = a + 1; i < b; i++) if (x[i - 1]! < 0 && x[i]! >= 0) { crossings++; if (first < 0) first = i; last = i; }
  return ((crossings - 1) * rate) / (last - first);
}

describe('pitch-preserving time stretch', () => {
  it('keeps a 440 Hz tone at 440 Hz (within 1%) from 0.25x to 4x with exact lengths', () => {
    const rate = 48000;
    const x = new Float32Array(rate * 4);
    for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
    for (const speed of [0.25, 0.5, 0.75, 1.25, 1.5, 2, 3, 4]) {
      const y = timeStretch(x, speed, rate);
      expect(Math.abs(y.length - Math.floor(x.length / speed))).toBeLessThanOrEqual(1);
      const f = frequency(y, rate);
      expect(Math.abs(f - 440) / 440).toBeLessThan(0.01);
      // No large dropouts: RMS stays near the input's.
      let s = 0; for (let i = 0; i < y.length; i++) s += y[i]! * y[i]!;
      expect(Math.sqrt(s / y.length)).toBeGreaterThan(0.3);
    }
  });
});
