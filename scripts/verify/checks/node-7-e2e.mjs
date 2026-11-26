import { runChecks, ensurePackaged } from '../lib.mjs';

// The same M0 to M6 end-to-end checks, driving the packaged Director.app instead of the dev build.
export default async () => {
  const app = ensurePackaged();
  const r = runChecks(['node-0-e2e', 'node-1-e2e', 'node-2-e2e', 'node-3-e2e', 'node-4-e2e', 'node-5-e2e', 'node-6-e2e'], { env: { DIRECTOR_PACKAGED_APP: app } });
  return `packaged app: ${r}`;
};
