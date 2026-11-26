import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';

// Ten minutes of automated scrubbing and short plays; the open VideoFrame count must return to baseline.
export default async function () {
  const minutes = Number(process.env.DIRECTOR_LEAK_MINUTES ?? 10);
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [a, b] = await importFixtures(win, ['sync-1080p30.mp4', 'cuts-720p.mp4']);
    await addToTimeline(win, a, 0, 'camera');
    await addToTimeline(win, b, 0, 'screen');
    const r = await win.evaluate(async (ms) => {
      const p = globalThis.__directorPlayer;
      await p.prepare();
      p.pool.clearCache();
      const base = p.stats.openFrames;
      const end = performance.now() + ms;
      let seeks = 0, plays = 0, peak = 0, rnd = 3;
      while (performance.now() < end) {
        rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
        if (rnd % 20 === 0) { await p.play(); await new Promise((x) => setTimeout(x, 300)); p.pause(); plays++; }
        else { await p.seek(Math.round((rnd / 0x7fffffff) * 9.9e6)); seeks++; }
        peak = Math.max(peak, p.stats.openFrames);
      }
      p.pause();
      await new Promise((x) => setTimeout(x, 500));
      p.pool.clearCache();
      await new Promise((x) => setTimeout(x, 200));
      const { frameStats } = globalThis.__directorMedia;
      return { base, after: frameStats.open, decoded: frameStats.decoded, seeks, plays, peak };
    }, minutes * 60_000);
    const detail = `${r.seeks} seeks, ${r.plays} plays over ${minutes} min; open frames base ${r.base}, peak ${r.peak}, after ${r.after}; decoded ${r.decoded}`;
    assert(r.after === r.base, `VideoFrame leak: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
