import { assert, tmp, sh } from '../lib.mjs';
import { launchEditor, colorImages, RENDER_SNIPPET } from '../edit-lib.mjs';
import { join } from 'node:path';

export default async function () {
  const dir = tmp('kmp');
  const imgs = colorImages(dir);
  const green = join(dir, 'greenscreen.png');
  sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=1920x1080', '-vf', 'drawbox=x=760:y=340:w=400:h=400:color=0xff0000:t=fill', '-frames:v', '1', green]);
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    await win.evaluate(RENDER_SNIPPET);
    const ids = await win.evaluate(async (p) => (await globalThis.__directorLibrary.importPaths(p)).map((m) => m.id), [imgs.blue, green, imgs.red]);
    const r = await win.evaluate(async ({ ids }) => {
      const base = globalThis.__directorProject().doc;
      const lane = (k) => base.lanes.find((l) => l.kind === k).id;
      const E = globalThis.__directorEngine;
      const clip = (id, mediaId, extra = {}) => ({ ...E.newClip({ kind: 'media', mediaId, start: 0, in: 0, out: 3_000_000 }), id, ...extra });
      const pts = [[0.5, 0.5], [0.1, 0.1], [0.3, 0.5], [0.9, 0.9], [0.85, 0.85], [0.15, 0.15], [0.5, 0.25], [0.5, 0.75]];
      // Chroma key: green screen with a red square over blue.
      const key = globalThis.__directorAnalysisApply(base, [{ op: 'addClip', laneId: lane('camera'), clip: clip('bg', ids[0]) }, { op: 'addClip', laneId: lane('broll'), clip: clip('fg', ids[1], { effects: [{ id: 'k', type: 'chromakey', enabled: true, params: { color: '#00ff00', similarity: 0.3, smoothness: 0.05 } }] }) }]);
      // Masks: red over blue through a centered rectangle and an ellipse.
      const rect = globalThis.__directorAnalysisApply(base, [{ op: 'addClip', laneId: lane('camera'), clip: clip('bg', ids[0]) }, { op: 'addClip', laneId: lane('broll'), clip: clip('fg', ids[2], { effects: [{ id: 'm', type: 'mask', enabled: true, params: { shape: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 0.001, invert: false } }] }) }]);
      const ell = globalThis.__directorAnalysisApply(base, [{ op: 'addClip', laneId: lane('camera'), clip: clip('bg', ids[0]) }, { op: 'addClip', laneId: lane('broll'), clip: clip('fg', ids[2], { effects: [{ id: 'm', type: 'mask', enabled: true, params: { shape: 'ellipse', x: 0, y: 0, w: 1, h: 1, feather: 0.01, invert: false } }] }) }]);
      // PiP bottom-right: red PiP over blue.
      const pipT = E.pipTransform('bottom-right', base.canvas);
      const pip = globalThis.__directorAnalysisApply(base, [{ op: 'addClip', laneId: lane('camera'), clip: clip('bg', ids[0]) }, { op: 'addClip', laneId: lane('broll'), clip: clip('fg', ids[2], pipT) }]);
      return { key: await globalThis.__renderAt(key, 500_000, 0.25, pts), rect: await globalThis.__renderAt(rect, 500_000, 0.25, pts), ell: await globalThis.__renderAt(ell, 500_000, 0.25, pts), pip: await globalThis.__renderAt(pip, 500_000, 0.25, pts) };
    }, { ids });
    const R = (c) => c[0] > 220 && c[1] < 40 && c[2] < 40, B = (c) => c[2] > 220 && c[0] < 40 && c[1] < 40;
    const fails = [];
    const want = (name, arr, i, f, label) => { if (!f(arr[i])) fails.push(`${name} point ${i} ${arr[i].slice(0, 3)} should be ${label}`); };
    want('key', r.key, 0, R, 'red (kept subject)'); want('key', r.key, 1, B, 'blue (keyed green)'); want('key', r.key, 3, B, 'blue');
    want('rect', r.rect, 0, R, 'red'); want('rect', r.rect, 1, B, 'blue'); want('rect', r.rect, 2, R, 'red'); want('rect', r.rect, 3, B, 'blue');
    want('ellipse', r.ell, 0, R, 'red'); want('ellipse', r.ell, 1, B, 'blue (outside ellipse corner)'); want('ellipse', r.ell, 6, R, 'red'); want('ellipse', r.ell, 7, R, 'red');
    want('pip', r.pip, 4, R, 'red (PiP)'); want('pip', r.pip, 0, B, 'blue'); want('pip', r.pip, 5, B, 'blue');
    assert(fails.length === 0, fails.join('\n'));
    return 'chroma key, rectangle and ellipse masks, and bottom-right PiP produce the expected pixels';
  } finally { await app.close(); }
}
