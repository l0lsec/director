import { vitest, assert } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet } from '../capture-lib.mjs';

export default async function () {
  const unit = vitest(['packages/engine/test/takeimport.test.ts'], { min: 3 });
  const { app, win } = await launchWithFakeDevices();
  try {
    await recordFor(win, 4000);
    const res = await stopAndGet(win);
    const ok = await win.evaluate((e) => globalThis.__directorRecord.sendToEditor(e), res);
    assert(ok, 'sendToEditor applied');
    await win.waitForSelector('[data-testid="workspace-edit"]', { state: 'attached', timeout: 10_000 });
    const p = await win.evaluate(() => globalThis.__directorProject());
    const lane = (k) => p.doc.lanes.find((l) => l.kind === k);
    const cam = lane('camera').clips[0];
    const voice = lane('voice').clips[0];
    assert(cam && voice, 'camera and voice clips exist');
    const frame = 1_000_000 / 30;
    const end = (c) => c.start + (c.out - c.in) / c.speed.rate;
    assert(Math.abs(cam.start - voice.start) <= frame && Math.abs(end(cam) - end(voice)) <= frame, 'camera and voice synced within a frame');
    assert(cam.linkGroup && cam.linkGroup === voice.linkGroup, 'linked');
    assert(p.doc.scriptText && p.doc.scriptText.includes('Stop typing'), 'script attached');
    assert(p.doc.media[cam.mediaId].durationUs > 3_500_000, 'media probed');
    // Durability: the journal holds the change.
    const seq = p.seq;
    assert(seq >= 1, 'journaled');
    return `${unit}; camera+voice linked at ${cam.start} us, script attached, journal seq ${seq}`;
  } finally { await app.close(); }
}
