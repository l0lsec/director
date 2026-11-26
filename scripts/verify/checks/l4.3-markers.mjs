import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/analysis/test/m4.test.ts'], { min: 1, pattern: 'retake marker overrides' });
