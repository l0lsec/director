import { assert, sh } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet, beepTimes, flashTimes, frameCount } from '../capture-lib.mjs';
import { join } from 'node:path';

// Recorder-side timing over a 2-minute take: both tracks stay real-time and in step with each other.
// Also reports the fake sources' own content rates, which are outside the recorder's control.
export default async function () {
  const minutes = Number(process.env.DIRECTOR_SYNC_MINUTES ?? 2);
  const { app, win } = await launchWithFakeDevices();
  let res;
  const wallStart = Date.now();
  try {
    await win.evaluate(() => { const r = globalThis.__directorRecord; const def = r.get().mics.find((m) => m.id === 'default'); if (def) r.setOption('micId', def.id); });
    await win.evaluate(() => globalThis.__directorRecord.startPreview());
    await new Promise((r) => setTimeout(r, 1500));
    const statsBefore = await win.evaluate(() => { const t = globalThis.__directorRecord.get().stream.getVideoTracks()[0]; return t.stats ? { ...t.stats.toJSON?.() ?? { deliveredFrames: t.stats.deliveredFrames, totalFrames: t.stats.totalFrames } } : null; });
    await recordFor(win, minutes * 60_000);
    const statsAfter = await win.evaluate(() => { const t = globalThis.__directorRecord.get().stream.getVideoTracks()[0]; return t.stats ? { ...t.stats.toJSON?.() ?? { deliveredFrames: t.stats.deliveredFrames, totalFrames: t.stats.totalFrames } } : null; });
    res = await stopAndGet(win);
    res.delivered = statsBefore && statsAfter ? statsAfter.deliveredFrames - statsBefore.deliveredFrames : null;
  } finally { await app.close(); }
  const file = join(res.dir, res.take.files.camera);
  const streams = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'json', file]).stdout).streams;
  const a = Number(streams.find((s) => s.codec_type === 'audio').duration);
  const v = Number(streams.find((s) => s.codec_type === 'video').duration);
  const fc = frameCount(file);
  const span = (xs) => (xs[xs.length - 1] - xs[0]) / (xs.length - 1);
  const beepRate = span(beepTimes(file));
  const flashRate = span(flashTimes(file));
  const wall = (res.take.durationUs / 1e6);
  const delivered = res.delivered;
  const detail = `audio track ${a.toFixed(3)} s, video track ${v.toFixed(3)} s (diff ${((a - v) * 1000).toFixed(1)} ms); frames recorded ${fc.frames}, delivered by the camera track ${delivered ?? 'n/a'} (${(fc.frames / fc.duration).toFixed(2)} fps); take clock ${wall.toFixed(3)} s; fake source content rates: mic beeps every ${beepRate.toFixed(5)} s, camera flashes every ${flashRate.toFixed(5)} s`;
  // Both streams end on their own packet boundaries: allow one video frame plus one AAC packet (1024/48000 s).
  assert(Math.abs(a - v) <= 1 / 30 + 1024 / 48000, `track durations differ by more than a frame plus a packet: ${detail}`);
  assert(delivered != null && Math.abs(fc.frames - delivered) <= 3, `recorder dropped frames the camera delivered: ${detail}`);
  assert(Math.abs(v - wall) <= 0.6, `video duration does not match the take clock: ${detail}`);
  void wallStart;
  return detail;
}
