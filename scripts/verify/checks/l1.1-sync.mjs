import { assert } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet, avOffsets, frameCount } from '../capture-lib.mjs';
import { join } from 'node:path';

// Fake camera and mic are fed from the flash/beep fixture (each second: a white frame and a 1 kHz beep).
// The recording must keep them together from start to end, with no dropped frames.
export default async function () {
  const minutes = Number(process.env.DIRECTOR_SYNC_MINUTES ?? 2);
  const { app, win } = await launchWithFakeDevices();
  let res;
  try {
    await win.evaluate(() => { const r = globalThis.__directorRecord; const mics = r.get().mics; const def = mics.find((m) => m.id === 'default'); if (def) r.setOption('micId', def.id); });
    await win.evaluate(() => globalThis.__directorRecord.startPreview());
    await new Promise((r) => setTimeout(r, 1500));
    await recordFor(win, minutes * 60_000);
    res = await stopAndGet(win);
  } finally {
    await app.close();
  }
  const file = join(res.dir, res.take.files.camera);
  const offs = avOffsets(file);
  assert(offs.length >= minutes * 60 * 0.9, `paired only ${offs.length} flash/beep events`);
  const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const head = offs.filter((o) => o.t < 20).map((o) => o.offset);
  const tail = offs.filter((o) => o.t > minutes * 60 - 20).map((o) => o.offset);
  const start = median(head);
  const end = median(tail);
  const frame = 1 / 30;
  const fc = frameCount(file);
  const expected = Math.round(fc.duration * 30);
  const detail = `A/V offset start ${(start * 1000).toFixed(1)} ms, end ${(end * 1000).toFixed(1)} ms, drift ${((end - start) * 1000).toFixed(1)} ms; frames ${fc.frames} for ${fc.duration.toFixed(2)} s (expected ${expected})`;
  if (process.env.DIRECTOR_SYNC_DRIFT_ONLY === '1') {
    assert(Math.abs(end - start) <= frame, `drift over one frame: ${detail}`);
  } else {
    assert(Math.abs(start) <= frame && Math.abs(end) <= frame, `offset over one frame: ${detail}`);
  }
  assert(Math.abs(fc.frames - expected) <= 1, `frame count off: ${detail}`);
  return detail;
}
