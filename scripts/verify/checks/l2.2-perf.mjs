import { assert } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';

export default async function () {
  const { app, win } = await launchEditor();
  try {
    await win.evaluate(() => {
      const d = globalThis.__directorProject().doc;
      const base = { speed: { kind: 'constant', rate: 1, preservePitch: true }, reverse: false, transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false }, blend: 'normal', effects: [], enabled: true };
      const ops = [];
      let n = 0;
      for (const lane of d.lanes) for (let i = 0; i < 34 && n < 300; i++, n++) ops.push({ op: 'addClip', laneId: lane.id, clip: { ...base, id: `c${n}`, kind: 'text', start: i * 2_000_000, in: 0, out: 1_800_000, text: { content: `Clip ${n}`, font: 'Inter', size: 60, weight: 700, color: '#fff', align: 'center', lineHeight: 1.1, maxWidth: 0.8 } } });
      globalThis.__directorProjectApply(ops, '300 clips');
    });
    const r = await win.evaluate(async () => {
      const set = globalThis.__directorEditCmd.setEdit;
      const g = globalThis;
      set({ zoom: 60, scrollX: 0 });
      await new Promise((x) => setTimeout(x, 300));
      const draws0 = g.__directorTimelineDraws ?? 0;
      const frames = [];
      let last = performance.now();
      const end = last + 4000;
      let i = 0;
      await new Promise((resolve) => {
        const step = (now) => {
          frames.push(now - last); last = now; i++;
          // Alternate panning and zooming every frame.
          if (i % 2) set({ scrollX: (i * 13) % 3000 }); else set({ zoom: 30 + ((i * 7) % 200) });
          if (now < end) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
      const draws = (g.__directorTimelineDraws ?? 0) - draws0;
      const sorted = frames.slice(5).sort((a, b) => a - b);
      return { fps: (frames.length / 4), p95: sorted[Math.floor(sorted.length * 0.95)], draws, clips: globalThis.__directorProject().doc.lanes.reduce((n, l) => n + l.clips.length, 0) };
    });
    const detail = `${r.clips} clips: ${r.fps.toFixed(1)} fps while panning and zooming, p95 frame ${r.p95.toFixed(1)} ms, ${r.draws} timeline redraws`;
    assert(r.clips >= 300, detail);
    assert(r.fps >= 55 && r.draws >= r.fps * 4 * 0.9, `too slow: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
