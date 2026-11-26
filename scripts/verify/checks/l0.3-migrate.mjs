import { vitest } from '../lib.mjs';
export default async () => vitest(['packages/engine/test/migrate.test.ts'], { min: 2 });
