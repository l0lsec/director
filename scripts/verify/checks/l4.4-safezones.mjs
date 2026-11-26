import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/analysis/test/m4.test.ts'], { min: 1, pattern: 'safe zone' });
