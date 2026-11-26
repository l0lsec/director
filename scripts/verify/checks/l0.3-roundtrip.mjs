import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/engine/test/roundtrip.test.ts'], { min: 2 });
