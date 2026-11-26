import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/engine/test/undo.test.ts', 'packages/engine/test/commands.test.ts'], { min: 10 });
