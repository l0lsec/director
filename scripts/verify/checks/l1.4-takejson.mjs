import { vitest, assert } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet } from '../capture-lib.mjs';

export default async function () {
  const { app, win } = await launchWithFakeDevices();
  let res;
  try {
    await win.evaluate(() => { const r = globalThis.__directorRecord; r.setOption('wpm', 240); });
    await recordFor(win, 3000);
    await win.evaluate(() => { const r = globalThis.__directorRecord; r.handleKey('R'); r.handleKey('M'); });
    await new Promise((r) => setTimeout(r, 3000));
    res = await stopAndGet(win);
  } finally { await app.close(); }
  assert(res.dir, 'take dir');
  return vitest(['apps/desktop/test/unit/takejson.test.ts'], { min: 1, env: { DIRECTOR_TAKE_DIR: res.dir } });
}
