import { vitest } from '../lib.mjs';
export default async () => vitest(['apps/desktop/test/unit/ipc.test.ts'], { min: 3 });
