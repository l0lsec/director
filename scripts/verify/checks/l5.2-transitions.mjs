import { assert, tmp } from '../lib.mjs';
import { launchEditor, colorImages, RENDER_SNIPPET } from '../edit-lib.mjs';

const near = (a, b, tol = 3) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);

export default async function () {
  const imgs = colorImages(tmp('trans'));
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    await win.evaluate(RENDER_SNIPPET);
    const ids = await win.evaluate(async (paths) => (await globalThis.__directorLibrary.importPaths(paths)).map((m) => m.id), [imgs.red, imgs.blue]);
    const results = await win.evaluate(async ({ ids }) => {
      const base = globalThis.__directorProject().doc;
      const cam = base.lanes.find((l) => l.kind === 'camera').id;
      const mk = (id, mediaId, start, tr) => ({ id, kind: 'media', mediaId, start, in: 0, out: 2_000_000, speed: { kind: 'constant', rate: 1, preservePitch: true }, reverse: false, transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false }, blend: 'normal', effects: [], enabled: true, ...(tr ? { transitionIn: tr } : {}) });
      const out = {};
      for (const type of ['crossfade', 'dip-black', 'dip-white', 'slide-left', 'slide-up', 'zoom', 'whip']) {
        const doc = globalThis.__directorAnalysisApply(base, [{ op: 'addClip', laneId: cam, clip: mk('A', ids[0], 0) }, { op: 'addClip', laneId: cam, clip: mk('B', ids[1], 2_000_000, { type, duration: 1_000_000 }) }]);
        out[type] = {};
        for (const p of [0.0001, 0.25, 0.5, 0.75, 0.9999]) out[type][p] = await globalThis.__renderAt(doc, 2_000_000 + Math.round(p * 1_000_000), 0.25, [[0.5, 0.5], [0.05, 0.5], [0.95, 0.5], [0.5, 0.05], [0.5, 0.95]]);
        out[type].after = await globalThis.__renderAt(doc, 3_200_000, 0.25, [[0.5, 0.5]]);
      }
      return out;
    }, { ids });
    const R = [255, 0, 0], B = [0, 0, 255], K = [0, 0, 0], W = [255, 255, 255];
    const mix = (a, b, f) => a.map((v, i) => Math.round(v * (1 - f) + b[i] * f));
    const fails = [];
    const expect = (type, p, idx, want, tol) => { const got = results[type][p][idx]; if (!near(got, want, tol)) fails.push(`${type} p=${p} point ${idx}: ${got.slice(0, 3)} want ${want}`); };
    for (const p of [0.25, 0.5, 0.75]) expect('crossfade', p, 0, mix(R, B, p), 4);
    expect('crossfade', 0.0001, 0, R, 4); expect('crossfade', 0.9999, 0, B, 4);
    expect('dip-black', 0.25, 0, mix(K, R, 0.5), 4); expect('dip-black', 0.75, 0, mix(K, B, 0.5), 4); expect('dip-black', 0.9999, 0, B, 4);
    expect('dip-white', 0.25, 0, mix(W, R, 0.5), 4); expect('dip-white', 0.75, 0, mix(W, B, 0.5), 4);
    // Slide left: the incoming clip enters from the right, offset (1 - ease) * width, ease = 1 - (1 - p)^3.
    expect('slide-left', 0.25, 2, B, 2); expect('slide-left', 0.25, 1, K, 2); expect('slide-left', 0.9999, 1, B, 2);
    expect('slide-up', 0.25, 4, B, 2); expect('slide-up', 0.25, 3, K, 2);
    expect('zoom', 0.5, 0, mix(K, B, 0.5), 4); expect('zoom', 0.9999, 0, B, 4);
    expect('whip', 0.0001, 1, K, 2); expect('whip', 0.9999, 0, B, 4);
    for (const type of Object.keys(results)) if (!near(results[type].after[0], B, 2)) fails.push(`${type}: after the transition ${results[type].after[0]}`);
    assert(fails.length === 0, `${fails.length} transition values off:\n${fails.join('\n')}`);
    return '7 transitions match the expected start, middle and end values (crossfade mixes the outgoing clip)';
  } finally { await app.close(); }
}
