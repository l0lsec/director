import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';

export default async function () {
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [id] = await importFixtures(win, ['hevc-4k.mp4']);
    const m = await win.evaluate((i) => globalThis.__directorProject().doc.media[i], id);
    assert(m.proxyPath && m.proxyPath.endsWith('proxy.mp4'), `no proxy for 4K HEVC: ${JSON.stringify(m)}`);
    await addToTimeline(win, id, 0, 'camera');
    const times = await win.evaluate(async () => {
      const p = globalThis.__directorPlayer;
      await p.prepare();
      const out = [];
      let r = 11;
      for (let i = 0; i < 60; i++) {
        r = (r * 1103515245 + 12345) & 0x7fffffff;
        const t = Math.round((r / 0x7fffffff) * 2.9e6);
        const t0 = performance.now();
        await p.seek(t);
        out.push(performance.now() - t0);
      }
      return out;
    });
    const s = [...times].sort((a, b) => a - b);
    const p95 = s[Math.floor(s.length * 0.95)];
    const detail = `proxy ${m.proxyPath.split('/').slice(-2).join('/')}; scrub p50 ${s[30].toFixed(1)} ms, p95 ${p95.toFixed(1)} ms over 60 random seeks`;
    assert(p95 <= 80, `scrub too slow: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
