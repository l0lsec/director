import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/engine/test/script.test.ts', 'packages/analysis/test/aligner.test.ts'], { min: 3, pattern: 'cue' });
