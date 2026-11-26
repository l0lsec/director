import { assert, tmp } from '../lib.mjs';
import { launchEditor, colorImages, RENDER_SNIPPET } from '../edit-lib.mjs';
import { writeFileSync } from 'node:fs';

// Cost of each effect at 1080p: render 120 frames with and without it (GPU work forced with readPixels).
export default async function () {
  const dir = tmp('fxcost');
  const imgs = colorImages(dir);
  const N = 33; let cube = `LUT_3D_SIZE ${N}\n`;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) cube += `${(r / (N - 1)) ** 0.9} ${(g / (N - 1)) ** 1.1} ${b / (N - 1)}\n`;
  writeFileSync(`${dir}/look.cube`, cube);
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    await win.evaluate(RENDER_SNIPPET);
    const [id] = await win.evaluate(async (paths) => (await globalThis.__directorLibrary.importPaths(paths)).map((m) => m.id), [imgs.grad]);
    const r = await win.evaluate(async ({ id, lut }) => {
      const base = globalThis.__directorProject().doc;
      const cam = base.lanes.find((l) => l.kind === 'camera').id;
      const clip = (effects) => ({ id: 'G', kind: 'media', mediaId: id, start: 0, in: 0, out: 10_000_000, speed: { kind: 'constant', rate: 1, preservePitch: true }, reverse: false, transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false }, blend: 'normal', effects, enabled: true });
      const time = async (effects) => {
        const doc = globalThis.__directorAnalysisApply(base, [{ op: 'addClip', laneId: cam, clip: clip(effects) }]);
        await globalThis.__renderAt(doc, 0, 1, [[0.5, 0.5]]);
        const t0 = performance.now();
        for (let i = 0; i < 120; i++) await globalThis.__renderAt(doc, i * 33_333, 1, [[0.5, 0.5]]);
        return (performance.now() - t0) / 120;
      };
      const fx = {
        color: { exposure: 0.3, contrast: 0.2, saturation: 0.2, temperature: 0.2, tint: 0, brightness: 0 },
        lut: { path: lut, strength: 1 }, blur: { radius: 20 }, vignette: { amount: 0.6 },
        zoom: { at: 0, amount: 1.2, ramp: 200_000 }, shake: { amount: 14, frequency: 9 },
        chromakey: { color: '#00ff00', similarity: 0.3, smoothness: 0.1 }, mask: { shape: 'ellipse', x: 0.1, y: 0.1, w: 0.8, h: 0.8, feather: 0.1, invert: false },
      };
      const baseMs = Math.min(await time([]), await time([]));
      const out = { baseMs };
      for (const [type, params] of Object.entries(fx)) out[type] = Math.min(await time([{ id: 'x', type, enabled: true, params }]), await time([{ id: 'x', type, enabled: true, params }])) - baseMs;
      return out;
    }, { id, lut: `${dir}/look.cube` });
    const over = Object.entries(r).filter(([k, v]) => k !== 'baseMs' && v > 2);
    const detail = `base frame ${r.baseMs.toFixed(2)} ms; extra per effect: ${Object.entries(r).filter(([k]) => k !== 'baseMs').map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ')} ms`;
    assert(over.length === 0, `effects over 2 ms: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
