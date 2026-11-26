import { vitest } from '../lib.mjs';
// Strict form of the gate: every word within 300 ms at p95.
export default async () => vitest(['apps/desktop/test/unit/voicefollow.test.ts'], { min: 1, pattern: 'strict', env: { DIRECTOR_STRICT_LATENCY: '1' } });
