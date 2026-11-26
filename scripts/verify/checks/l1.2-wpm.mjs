import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/engine/test/script.test.ts'], { min: 2, pattern: 'fixed-speed' });
