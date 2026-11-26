import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/media/test/stretch.test.ts', 'packages/engine/test/keyframes.test.ts'], { min: 2, pattern: 'time stretch|exact clip durations' });
