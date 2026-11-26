import { vitest } from '../lib.mjs';
// Every engine command, primitive op, palette command, effect, transition, animation, caption style,
// ramp, layout, keyframe property, lane and marker kind, plus named professional tasks.
export default async () => vitest(['packages/agent/test/coverage.test.ts'], { min: 15 });
