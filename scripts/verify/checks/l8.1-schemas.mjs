import { vitest } from '../lib.mjs';
// Names, descriptions with units, annotations, JSON schemas in three formats, examples that validate.
export default async () => vitest(['packages/agent/test/catalog.test.ts'], { min: 2, pattern: 'catalog shape' });
