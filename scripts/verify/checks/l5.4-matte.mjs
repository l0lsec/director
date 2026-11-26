import { assert, tmp, sh, root, fixture } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline, colorImages, RENDER_SNIPPET } from '../edit-lib.mjs';
import { join } from 'node:path';

// Background-removal compositing with a known matte: inside the matte the clip shows, outside the
// layer below shows. Also runs Vision segmentation on a real video and checks the matte's timing.
export default async function () {
  const dir = tmp('matte');
  const imgs = colorImages(dir);
  const matte = join(dir, 'circle-matte.mp4');
  sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:r=30:d=4', '-vf', "geq=lum='if(lt(hypot(X-960\\,Y-540)\\,300)\\,255\\,0)':cb=128:cr=128,format=yuv420p", '-c:v', 'libx264', '-g', '30', matte]);
  const seg = sh(join(root, 'native/DirectorKit/.build/release/director-native'), ['segment', '--file', fixture('vertical-1080x1920.mp4'), '--out', join(dir, 'seg.mov'), '--quality', 'fast']).stdout;
  assert(/"done":true/.test(seg), `segmentation failed: ${seg.slice(-200)}`);
  const segDur = Number(sh('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(dir, 'seg.mov')]).stdout);
  assert(Math.abs(segDur - 5) < 0.1, `matte duration ${segDur}`);
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    await win.evaluate(RENDER_SNIPPET);
    const [blue] = await win.evaluate(async (p) => (await globalThis.__directorLibrary.importPaths(p)).map((m) => m.id), [imgs.blue]);
    const [vid] = await importFixtures(win, ['sync-1080p30.mp4']);
    await addToTimeline(win, blue, 0, 'camera');
    await addToTimeline(win, vid, 0, 'broll');
    await win.evaluate((m) => { const d = globalThis.__directorProject().doc; const c = d.lanes.find((l) => l.kind === 'broll').clips[0]; globalThis.__directorProjectApply([{ op: 'updateClip', id: c.id, patch: { effects: [{ id: 'm', type: 'matte', enabled: true, params: { path: m } }] } }], 'matte'); }, matte);
    await win.evaluate(() => globalThis.__directorPlayer.prepare());
    // Render through the real player (which resolves the matte video alongside the clip).
    const px = await win.evaluate(async () => { const p = globalThis.__directorPlayer; p.scale = 0.5; await p.seek(1_016_000); const rd = (x, y) => Array.from(p.comp.readPixels(Math.round(x * p.comp.width), Math.round(y * p.comp.height), 1, 1)); return { center: rd(0.5, 0.5), corner: rd(0.1, 0.9), edgeOut: rd(0.5 + 360 / 1920, 0.5), edgeIn: rd(0.5 + 240 / 1920, 0.5) }; });
    const isBlue = (c) => c[2] > 200 && c[0] < 40 && c[1] < 40;
    assert(!isBlue(px.center) && !isBlue(px.edgeIn), `inside the matte should show the clip: ${JSON.stringify(px)}`);
    assert(isBlue(px.corner) && isBlue(px.edgeOut), `outside the matte should show the layer below: ${JSON.stringify(px)}`);
    return `matte cuts the clip to the circle (inside shows video, outside shows the blue layer below); Vision segmentation produced a ${segDur.toFixed(2)} s matte`;
  } finally { await app.close(); }
}
