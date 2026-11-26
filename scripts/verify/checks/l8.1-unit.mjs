import { vitest } from '../lib.mjs';
// Every write tool's examples: schema-valid result, exact undo, dry run and rejection change nothing.
export default async () => vitest(['packages/agent/test/catalog.test.ts'], { min: 150, pattern: 'edit tools|read and app tools' });
