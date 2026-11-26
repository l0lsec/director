import { vitest } from '../lib.mjs';
export default async () => vitest(['apps/desktop/test/unit/probe.test.ts'], { min: 2 });
