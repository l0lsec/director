import { vitest } from '../lib.mjs';
export default async () => vitest(['apps/desktop/test/unit/jobs.test.ts'], { min: 3 });
