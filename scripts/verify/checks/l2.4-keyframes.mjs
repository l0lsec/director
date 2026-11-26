import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/engine/test/keyframes.test.ts'], { min: 3 });
