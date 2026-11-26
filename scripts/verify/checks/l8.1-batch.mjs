import { vitest } from '../lib.mjs';
// Atomic batches, named failing steps, dry-run batches, stale revisions refused, re-plan on concurrent edits.
export default async () => vitest(['packages/agent/test/batch.test.ts'], { min: 6 });
