// Lets plain Node (24+) import this repo's TypeScript sources: resolves extensionless and
// directory imports to .ts/.tsx/index.ts. Use with:
//   node --no-warnings --import ./scripts/verify/ts-register.mjs file.ts   (the repo keeps to erasable TypeScript syntax)
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
