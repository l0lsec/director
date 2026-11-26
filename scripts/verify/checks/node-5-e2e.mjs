import { assert, tmp } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline, exportAndWait, colorImages } from '../edit-lib.mjs';
import { writeFileSync } from 'node:fs';

// One timeline using the M5 toolkit together: template text, crossfade, color + LUT, vignette, ellipse mask,
// PiP, freeze frame, speed ramp, ducked music. The export must match the preview frame for frame.
export default async function () {
  const dir = tmp('node5');
  const imgs = colorImages(dir);
  const N = 9; let cube = `LUT_3D_SIZE ${N}\n`;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) cube += `${Math.min(1, (r / 8) * 1.1)} ${g / 8} ${(b / 8) * 0.9}\n`;
  writeFileSync(`${dir}/warm.cube`, cube);
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [sync, cuts, tone, speech] = await importFixtures(win, ['sync-1080p30.mp4', 'cuts-720p.mp4', 'tone-440.wav', 'speech.wav']);
    const [blue] = await win.evaluate(async (p) => (await globalThis.__directorLibrary.importPaths(p)).map((m) => m.id), [imgs.blue]);
    await addToTimeline(win, sync, 0, 'camera');
    await addToTimeline(win, blue, 10_000_000, 'camera');
    await addToTimeline(win, cuts, 0, 'broll');
    await addToTimeline(win, tone, 0, 'music');
    await addToTimeline(win, speech, 0, 'voice');
    await win.evaluate(({ lut }) => {
      const E = globalThis.__directorEngine;
      const apply = globalThis.__directorProjectApply;
      let d = globalThis.__directorProject().doc;
      const cam = d.lanes.find((l) => l.kind === 'camera').clips;
      const broll = d.lanes.find((l) => l.kind === 'broll').clips[0];
      const music = d.lanes.find((l) => l.kind === 'music').clips[0];
      apply([
        { op: 'updateClip', id: cam[0].id, patch: { effects: [{ id: 'c', type: 'color', enabled: true, params: { exposure: 0.2, contrast: 0.15, saturation: 0.1, temperature: 0.2, tint: 0, brightness: 0 } }, { id: 'l', type: 'lut', enabled: true, params: { path: lut, strength: 0.8 } }, { id: 'v', type: 'vignette', enabled: true, params: { amount: 0.5 } }] } },
        { op: 'updateClip', id: cam[1].id, patch: { transitionIn: { type: 'crossfade', duration: 600_000 } } },
        { op: 'updateClip', id: broll.id, patch: { ...E.pipTransform('top-right', d.canvas), effects: [{ id: 'm', type: 'mask', enabled: true, params: { shape: 'ellipse', x: 0, y: 0, w: 1, h: 1, feather: 0.05, invert: false } }] } },
        { op: 'updateClip', id: music.id, patch: { audio: { ...music.audio, duckable: true, gainDb: { value: -6 } } } },
      ], 'showcase');
      d = globalThis.__directorProject().doc;
      apply(E.freezeFrameOps(d, d.lanes.find((l) => l.kind === 'broll').clips[0].id, 4_000_000, 700_000), 'freeze');
      d = globalThis.__directorProject().doc;
      apply(E.setRampOps(d, d.lanes.find((l) => l.kind === 'broll').clips[2].id, 'ease-in', false), 'ramp');
      d = globalThis.__directorProject().doc;
      const tpl = E.makeTemplate(globalThis.__directorAnalysisApply(d, [{ op: 'addClip', laneId: d.lanes.find((l) => l.kind === 'titles').id, clip: { ...E.newClip({ kind: 'text', start: 0, out: 3_000_000 }), id: 'tt', text: { content: 'X', font: 'Inter', size: 100, weight: 900, color: '#fff', align: 'center', lineHeight: 1, maxWidth: 0.8, stroke: { color: '#000', width: 8 }, animationIn: 'pop' } } }]), ['tt'], 'T');
      apply(E.applyTemplateOps(d, tpl, 1_000_000, ['SHOWCASE']), 'template');
    }, { lut: `${dir}/warm.cube` });
    const job = await exportAndWait(win, 'youtube-1080', `${dir}/showcase.mp4`);
    assert(job.status === 'done', `export ${job.status}: ${job.error}`);
    const scores = await win.evaluate(async (file) => {
      const { lib } = globalThis.__directorMedia;
      const p = globalThis.__directorPlayer;
      p.scale = 1; await p.prepare();
      const pool = new lib.MediaPool();
      const W = 480, H = 270;
      const gray = (src, sw, sh) => { const c = new OffscreenCanvas(W, H); const x = c.getContext('2d'); x.drawImage(src, 0, 0, sw, sh, 0, 0, W, H); const d = x.getImageData(0, 0, W, H).data; const g = new Float32Array(W * H); for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return g; };
      const ssim = (a, b) => { const C1 = 6.5, C2 = 58.5; let t = 0, n = 0; for (let y = 0; y + 8 <= H; y += 8) for (let x = 0; x + 8 <= W; x += 8) { let ma = 0, mb = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * W + x + i; ma += a[k]; mb += b[k]; } ma /= 64; mb /= 64; let va = 0, vb = 0, cv = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * W + x + i; va += (a[k] - ma) ** 2; vb += (b[k] - mb) ** 2; cv += (a[k] - ma) * (b[k] - mb); } t += ((2 * ma * mb + C1) * (2 * cv / 63 + C2)) / ((ma * ma + mb * mb + C1) * ((va + vb) / 63 + C2)); n++; } return t / n; };
      const out = [];
      for (const frame of [20, 40, 125, 140, 200, 290, 305, 320]) {
        const t = Math.round(((frame + 0.5) / 30) * 1e6);
        await p.seek(t);
        const a = gray(p.comp.canvas, p.comp.width, p.comp.height);
        const f = await pool.frameAt(file, t / 1e6);
        const b = gray(f.frame, f.width, f.height); f.frame.close();
        out.push(ssim(a, b));
      }
      return out;
    }, `${dir}/showcase.mp4`);
    const min = Math.min(...scores);
    assert(min >= 0.98, `export differs from preview: ${scores.map((s) => s.toFixed(3)).join(' ')}`);
    return `showcase timeline exported; 8 frames vs preview SSIM min ${min.toFixed(4)}; ${job.result.loudness.integrated} LUFS`;
  } finally { await app.close(); }
}
