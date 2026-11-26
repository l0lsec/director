import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';

// During playback the displayed video frame must match the audio clock (the timeline time being heard).
export default async function () {
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [id] = await importFixtures(win, ['sync-1080p30.mp4']);
    await addToTimeline(win, id, 0, 'camera');
    const samples = await win.evaluate(async () => {
      const p = globalThis.__directorPlayer;
      p.scale = 0.5;
      await p.prepare();
      await p.seek(0);
      const out = [];
      const off = p.onTime((t, playing) => {
        if (!playing) return;
        let n = 0;
        for (let k = 0; k < 12; k++) { const px = p.comp.readPixels(Math.round((4 + k * 40 + 18) * 0.5), Math.round(24 * 0.5), 1, 1); if (px[0] > 128) n |= 1 << k; }
        out.push({ t, frame: n });
      });
      await p.play();
      await new Promise((r) => setTimeout(r, 9000));
      p.pause();
      off();
      return out;
    });
    assert(samples.length > 200, `only ${samples.length} samples`);
    const offsets = samples.map((s) => s.frame / 30 - s.t / 1e6);
    const sorted = [...offsets].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p05 = sorted[Math.floor(sorted.length * 0.05)];
    const frame = 1 / 30;
    const detail = `video minus audio clock: median ${(median * 1000).toFixed(1)} ms, 5th ${(p05 * 1000).toFixed(1)} ms, 95th ${(p95 * 1000).toFixed(1)} ms over ${samples.length} frames`;
    // The displayed frame covers [frame/30, (frame+1)/30): offsets in (-1 frame, 0] are perfect.
    assert(p05 >= -2 * frame && p95 <= frame, `out of sync: ${detail}`);
    assert(Math.abs(median + frame / 2) <= frame, `median offset over one frame: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
