import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline, readBarcode } from '../edit-lib.mjs';

export default async function () {
  const { app, win } = await launchEditor();
  try {
    const [id] = await importFixtures(win, ['sync-1080p30.mp4']);
    assert(await addToTimeline(win, id, 0, 'camera'), 'added to timeline');
    let rng = 7;
    const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
    const misses = [];
    for (let i = 0; i < 200; i++) {
      const frame = Math.floor(rand() * 299);
      // Aim inside the frame (not on its boundary) the way a scrub would land.
      const t = Math.round(((frame + 0.3 + rand() * 0.4) / 30) * 1e6);
      await win.evaluate((tt) => globalThis.__directorPlayer.seek(tt), t);
      const got = await readBarcode(win);
      if (got !== frame) misses.push(`${t}us want ${frame} got ${got}`);
    }
    assert(misses.length === 0, `${misses.length} wrong frames:\n${misses.slice(0, 10).join('\n')}`);
    return '200/200 random seeks showed the exact frame';
  } finally { await app.close(); }
}
