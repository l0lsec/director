import { assert, tmp, sh } from '../lib.mjs';
import { launchEditor, colorImages, RENDER_SNIPPET } from '../edit-lib.mjs';
import { writeFileSync } from 'node:fs';

// Reference implementation of the color stage, written independently of the shader source.
function reference(rgb, c) {
  let [r, g, b] = rgb.map((v) => v / 255);
  const k = Math.pow(2, c.exposure);
  [r, g, b] = [r * k + c.brightness, g * k + c.brightness, b * k + c.brightness].map((v) => (v - 0.5) * (1 + c.contrast) + 0.5);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  [r, g, b] = [r, g, b].map((v) => l + (v - l) * (1 + c.saturation));
  r += c.temperature * 0.1; g += c.tint * 0.1; b -= c.temperature * 0.1;
  return [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

export default async function () {
  const dir = tmp('color');
  const imgs = colorImages(dir);
  // Identity 3D LUT (size 17).
  const N = 17; let cube = `LUT_3D_SIZE ${N}\n`;
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) cube += `${(r / (N - 1)).toFixed(6)} ${(g / (N - 1)).toFixed(6)} ${(b / (N - 1)).toFixed(6)}\n`;
  writeFileSync(`${dir}/identity.cube`, cube);
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    await win.evaluate(RENDER_SNIPPET);
    const [id] = await win.evaluate(async (paths) => (await globalThis.__directorLibrary.importPaths(paths)).map((m) => m.id), [imgs.grad]);
    const CASES = [
      { exposure: 0.5, contrast: 0, saturation: 0, temperature: 0, tint: 0, brightness: 0 },
      { exposure: 0, contrast: 0.4, saturation: 0, temperature: 0, tint: 0, brightness: 0 },
      { exposure: 0, contrast: 0, saturation: -0.6, temperature: 0, tint: 0, brightness: 0 },
      { exposure: 0, contrast: 0, saturation: 0.5, temperature: 0.6, tint: -0.4, brightness: 0 },
      { exposure: -0.4, contrast: -0.2, saturation: 0.3, temperature: -0.5, tint: 0.3, brightness: 0.05 },
    ];
    const pts = [[0.1, 0.1], [0.3, 0.4], [0.5, 0.5], [0.7, 0.6], [0.9, 0.9]];
    const r = await win.evaluate(async ({ id, CASES, pts, lut }) => {
      const base = globalThis.__directorProject().doc;
      const cam = base.lanes.find((l) => l.kind === 'camera').id;
      const clip = (effects) => ({ id: 'G', kind: 'media', mediaId: id, start: 0, in: 0, out: 2_000_000, speed: { kind: 'constant', rate: 1, preservePitch: true }, reverse: false, transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false }, blend: 'normal', effects, enabled: true });
      const at = async (effects) => globalThis.__renderAt(globalThis.__directorAnalysisApply(base, [{ op: 'addClip', laneId: cam, clip: clip(effects) }]), 500_000, 0.25, pts);
      const plain = await at([]);
      const withLut = await at([{ id: 'l', type: 'lut', enabled: true, params: { path: lut, strength: 1 } }]);
      const graded = [];
      for (const c of CASES) graded.push(await at([{ id: 'c', type: 'color', enabled: true, params: c }]));
      return { plain, withLut, graded };
    }, { id, CASES, pts, lut: `${dir}/identity.cube` });
    const lutDiff = Math.max(...r.plain.flatMap((p, i) => p.slice(0, 3).map((v, k) => Math.abs(v - r.withLut[i][k]))));
    assert(lutDiff === 0, `identity LUT changed pixels by up to ${lutDiff}`);
    let worst = 0;
    CASES.forEach((c, ci) => r.graded[ci].forEach((px, pi) => { const want = reference(r.plain[pi], c); worst = Math.max(worst, ...want.map((v, k) => Math.abs(v - px[k]))); }));
    assert(worst <= 1, `color controls differ from the reference by up to ${worst} code values`);
    return `identity LUT pixel-exact; 5 color settings x 5 pixels within ${worst} code value of the reference`;
  } finally { await app.close(); }
}
