import { vitest } from '../lib.mjs';
export default async () => vitest(['apps/desktop/test/unit/download.test.ts'], { min: 3 });
