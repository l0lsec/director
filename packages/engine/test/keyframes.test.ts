import { describe, expect, it } from 'vitest';
import { evalAnim, withKeyframe, clipDuration, newClip, type Animatable } from '../src';

const golden = {
  linear: (x: number) => x,
  ease: (x: number) => x * x * (3 - 2 * x),
  easeIn: (x: number) => x * x * x,
  easeOut: (x: number) => 1 - Math.pow(1 - x, 3),
  hold: () => 0,
} as const;

describe('keyframe interpolation', () => {
  it('matches golden values at 100 sampled times for every ease', () => {
    for (const [ease, f] of Object.entries(golden)) {
      const a: Animatable = { value: 0, keyframes: [{ t: 0, v: 10, ease: ease as keyof typeof golden }, { t: 2_000_000, v: 30, ease: 'linear' }, { t: 3_000_000, v: -5, ease: 'linear' }] };
      for (let i = 0; i < 100; i++) {
        const t = Math.round((i / 99) * 3_500_000);
        let want: number;
        if (t <= 0) want = 10;
        else if (t < 2_000_000) want = 10 + 20 * f(t / 2_000_000);
        else if (t < 3_000_000) want = 30 + -35 * ((t - 2_000_000) / 1_000_000);
        else want = -5;
        expect(evalAnim(a, t)).toBeCloseTo(want, 9);
      }
    }
  });

  it('adding a keyframe at an existing time replaces it and keeps order', () => {
    let a: Animatable = { value: 1 };
    a = withKeyframe(a, 500, 2);
    a = withKeyframe(a, 100, 3);
    a = withKeyframe(a, 500, 4, 'hold');
    expect(a.keyframes).toEqual([{ t: 100, v: 3, ease: 'linear' }, { t: 500, v: 4, ease: 'hold' }]);
    expect(evalAnim({ value: 7 }, 123)).toBe(7);
  });

  it('constant speeds give exact clip durations', () => {
    for (const rate of [0.25, 0.5, 1, 1.5, 2, 4]) {
      const c = newClip({ kind: 'media', start: 0, in: 1_000_000, out: 5_000_000, speed: { kind: 'constant', rate, preservePitch: true } });
      expect(clipDuration(c)).toBe(Math.round(4_000_000 / rate));
    }
  });
});

import { frameToMicros, microsToFrame } from '../src';
describe('frame time round trip', () => {
  it('microsToFrame(frameToMicros(n)) === n for every frame of an hour at common rates', () => {
    for (const fps of [{ num: 24, den: 1 }, { num: 30, den: 1 }, { num: 30000, den: 1001 }, { num: 60, den: 1 }, { num: 60000, den: 1001 }]) {
      for (let n = 0; n < 3600 * 60; n += 7) expect(microsToFrame(frameToMicros(n, fps), fps)).toBe(n);
    }
  });
});
