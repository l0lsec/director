import { assert, sh, root } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet } from '../capture-lib.mjs';
import { join } from 'node:path';

// Needs macOS Screen Recording permission for the process running the check.
export default async function () {
  const probe = sh(join(root, 'native/DirectorKit/.build/release/director-native'), ['screen-sources'], { allowFail: true });
  assert(probe.status === 0, `screen capture not permitted: ${probe.stdout.trim()}`);
  const { app, win } = await launchWithFakeDevices();
  let res;
  try {
    await win.evaluate(() => globalThis.__directorRecord.setOption('screenOn', true));
    await recordFor(win, 8000);
    res = await stopAndGet(win);
  } finally { await app.close(); }
  assert(res.take.files.screen, 'screen file recorded');
  assert(typeof res.take.clock.screenOffsetUs === 'number' && Math.abs(res.take.clock.screenOffsetUs) < 2_000_000, `screen offset ${res.take.clock.screenOffsetUs}`);
  return `screen offset ${res.take.clock.screenOffsetUs} us`;
}
