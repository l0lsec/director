import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/analysis/test/aligner.test.ts'], { min: 4 });
