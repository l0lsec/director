import { assert, tmp } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline, exportAndWait } from '../edit-lib.mjs';

// Same compositor for preview and export: 20 frames of the exported file must match the preview render.
export default async function () {
  const out = tmp('parity');
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [sync, cuts, still] = await importFixtures(win, ['sync-1080p30.mp4', 'cuts-720p.mp4', 'still.png']);
    await addToTimeline(win, sync, 0, 'camera');
    await addToTimeline(win, cuts, 0, 'screen');
    await addToTimeline(win, still, 2_000_000, 'graphics');
    await win.evaluate(() => {
      const d = globalThis.__directorProject().doc;
      const ops = [];
      const scr = d.lanes.find((l) => l.kind === 'screen').clips[0];
      ops.push({ op: 'updateClip', id: scr.id, patch: { transform: { ...scr.transform, scale: { value: 0.4, keyframes: [{ t: 0, v: 0.3, ease: 'ease' }, { t: 5_000_000, v: 0.5, ease: 'linear' }] }, x: { value: -500 }, y: { value: 250 }, rotation: { value: 6 } } } });
      const g = d.lanes.find((l) => l.kind === 'graphics').clips[0];
      ops.push({ op: 'updateClip', id: g.id, patch: { transform: { ...g.transform, scale: { value: 0.25 }, x: { value: 650 }, y: { value: -320 }, opacity: { value: 0.8 } }, fit: 'contain' } });
      globalThis.__directorProjectApply(ops, 'layout');
      globalThis.__directorEditCmd.seek(500_000);
      globalThis.__directorEditCmd.addText('PARITY CHECK', 'titles', { start: 1_000_000, out: 6_000_000 });
    });
    const job = await exportAndWait(win, 'youtube-1080', `${out}/parity.mp4`, { loudness: false });
    assert(job.status === 'done', `export ${job.status}: ${job.error}`);
    const r = await win.evaluate(async (file) => {
      const { lib } = globalThis.__directorMedia;
      const p = globalThis.__directorPlayer;
      p.scale = 1;
      const mb = await import('mediabunny').catch(() => null);
      void mb;
      const pool = new lib.MediaPool();
      const W = 480, H = 270;
      const gray = (src, sw, sh) => {
        const c = new OffscreenCanvas(W, H); const x = c.getContext('2d'); x.drawImage(src, 0, 0, sw, sh, 0, 0, W, H);
        const d = x.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
        return g;
      };
      const ssim = (a, b) => {
        const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2; let total = 0, n = 0;
        for (let y = 0; y + 8 <= H; y += 8) for (let x = 0; x + 8 <= W; x += 8) {
          let ma = 0, mb = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * W + x + i; ma += a[k]; mb += b[k]; }
          ma /= 64; mb /= 64; let va = 0, vb = 0, cov = 0;
          for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * W + x + i; va += (a[k] - ma) ** 2; vb += (b[k] - mb) ** 2; cov += (a[k] - ma) * (b[k] - mb); }
          va /= 63; vb /= 63; cov /= 63;
          total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2)); n++;
        }
        return total / n;
      };
      const scores = [];
      for (let i = 0; i < 20; i++) {
        const frame = 7 + i * 14; // spread over 0..9.6 s
        const t = Math.round(((frame + 0.5) / 30) * 1e6);
        await p.seek(t);
        const prev = gray(p.comp.canvas, p.comp.width, p.comp.height);
        const f = await pool.frameAt(file, t / 1e6);
        const exp = gray(f.frame, f.width, f.height);
        f.frame.close();
        scores.push(ssim(prev, exp));
      }
      return scores;
    }, `${out}/parity.mp4`);
    const min = Math.min(...r);
    const detail = `SSIM over 20 frames: min ${min.toFixed(4)}, mean ${(r.reduce((a, b) => a + b, 0) / r.length).toFixed(4)} [${r.map((x) => x.toFixed(3)).join(' ')}]`;
    assert(min >= 0.98, `preview and export differ: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
