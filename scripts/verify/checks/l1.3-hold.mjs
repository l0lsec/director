import { vitest } from '../lib.mjs';
export default async () => vitest(['apps/desktop/test/unit/voicefollow.test.ts', 'packages/analysis/test/aligner.test.ts'], { min: 2, pattern: 'holds' });
