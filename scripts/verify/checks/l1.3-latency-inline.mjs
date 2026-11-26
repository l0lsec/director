import { vitest } from '../lib.mjs';
export default async () => vitest(['apps/desktop/test/unit/voicefollow.test.ts'], { min: 1, pattern: 'within-line' });
