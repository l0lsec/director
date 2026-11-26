import { vitest } from '../lib.mjs';
export default async () => vitest(['apps/desktop/test/unit/store.test.ts'], { min: 3 });
