// Helpers for editor checks: launch, create a project, import fixtures, read the preview.
import { launchApp, tmp, fixture, assert, sh } from './lib.mjs';

export async function launchEditor({ preset = 'landscape-1080', env = {} } = {}) {
  const projects = tmp('edit-projects-' + Math.random().toString(16).slice(2));
  const userData = tmp('edit-userdata-' + Math.random().toString(16).slice(2));
  const app = await launchApp({ env: { DIRECTOR_PROJECTS_DIR: projects, DIRECTOR_USER_DATA: userData, DIRECTOR_SHOW: '1', ...env } });
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="tab-edit"]');
  await win.evaluate(async (p) => {
    const r = await window.director.invoke('project:create', { name: 'Check', preset: p });
    await window.director.invoke('settings:set', { key: 'lastProjectDir', value: r.value.dir });
  }, preset);
  await win.click('[data-testid="tab-edit"]');
  await win.waitForSelector('[data-testid="preview-canvas"]', { state: 'attached', timeout: 20_000 });
  await win.waitForFunction(() => !!globalThis.__directorProject?.().doc && !!globalThis.__directorPlayer, null, { timeout: 20_000 });
  return { app, win, projects };
}

/** Import fixtures through the real importer and return their media ids. */
export async function importFixtures(win, names, role) {
  const paths = names.map((n) => fixture(n));
  const ids = await win.evaluate(async ({ paths, role }) => (await globalThis.__directorLibrary.importPaths(paths, role)).map((m) => m.id), { paths, role });
  assert(ids.length === names.length, `imported ${ids.length}/${names.length}`);
  return ids;
}

export async function addToTimeline(win, mediaId, at = 0, laneKind) {
  return win.evaluate(({ mediaId, at, laneKind }) => {
    const p = globalThis.__directorProject();
    const m = p.doc.media[mediaId];
    const lane = laneKind ? p.doc.lanes.find((l) => l.kind === laneKind).id : undefined;
    return globalThis.__directorEditCmd.addMediaToTimeline(m, at, lane);
  }, { mediaId, at, laneKind });
}

/** Decode the fixture's 12-bit frame barcode from the preview at the given output scale. */
export async function readBarcode(win, scale = null, cell = 40, bits = 12) {
  return win.evaluate(({ scale: fixed, cell, bits }) => {
    const comp = globalThis.__directorPlayer.comp;
    // Sample at the scale the frame was actually rendered at (the preview settles its size after load).
    const scale = fixed ?? comp.width / globalThis.__directorProject().doc.canvas.width;
    let n = 0;
    for (let k = 0; k < bits; k++) {
      const x = Math.round((4 + k * cell + cell / 2 - 2) * scale);
      const y = Math.round((4 + cell / 2) * scale);
      const px = comp.readPixels(x, y, 1, 1);
      if (px[0] > 128) n |= 1 << k;
    }
    return n;
  }, { scale, cell, bits });
}

/** Queue an export and wait for it to finish; returns the job (with result). */
export async function exportAndWait(win, preset, path, opts = {}, timeout = 900_000) {
  const id = await win.evaluate(({ preset, path, opts }) => globalThis.__directorExport.enqueueExport(globalThis.__directorProject().doc, preset, path, opts), { preset, path, opts });
  await win.waitForFunction((id) => { const j = globalThis.__directorExport.jobs().find((x) => x.id === id); return j && ['done', 'error', 'cancelled'].includes(j.status); }, id, { timeout, polling: 250 });
  return win.evaluate((id) => globalThis.__directorExport.jobs().find((x) => x.id === id), id);
}

/** Replace the project canvas and fill a lane by repeating a clip. */
export async function fillLane(win, mediaId, laneKind, totalUs, clipUs) {
  for (let t = 0; t < totalUs; t += clipUs) await addToTimeline(win, mediaId, t, laneKind);
  // Trim the last clip to the exact total.
  await win.evaluate(({ laneKind, totalUs }) => {
    const d = globalThis.__directorProject().doc;
    const lane = d.lanes.find((l) => l.kind === laneKind);
    const last = lane.clips[lane.clips.length - 1];
    const end = last.start + (last.out - last.in);
    if (end > totalUs) globalThis.__directorProjectApply([{ op: 'updateClip', id: last.id, patch: { out: last.in + (totalUs - last.start) } }], 'trim');
  }, { laneKind, totalUs });
}

/** Put a speech fixture on the Voice lane, optionally with a script and markers, and transcribe it in the app. */
export async function speechProject(win, fixtureName, { script, markers = [], preset } = {}) {
  const [id] = await importFixtures(win, [fixtureName]);
  await addToTimeline(win, id, 0, 'voice');
  await win.evaluate(({ script, markers }) => {
    const ops = [];
    if (script) ops.push({ op: 'setMeta', patch: { scriptText: script } });
    for (const m of markers) ops.push({ op: 'addMarker', marker: m });
    if (ops.length) globalThis.__directorProjectApply(ops, 'setup');
  }, { script, markers });
  await win.click('[data-testid="tab-edit"]');
  await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'transcript' }));
  await win.waitForFunction(() => !!globalThis.__directorTranscript, null, { timeout: 10_000 });
  await win.evaluate(() => globalThis.__directorTranscript.ensureTranscripts());
  return id;
}

export const S_US = 1_000_000;

/** Solid-color and gradient PNGs for analytic render checks. */
export function colorImages(dir) {
  const mk = (name, src) => { const p = `${dir}/${name}.png`; sh('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', p]); return p; };
  return {
    red: mk('red', 'color=c=0xff0000:s=1920x1080'),
    blue: mk('blue', 'color=c=0x0000ff:s=1920x1080'),
    grad: mk('grad', 'gradients=s=1920x1080:c0=0x204060:c1=0xc0a080:x0=0:y0=0:x1=1919:y1=1079:nb_colors=2,format=rgb24'),
  };
}

/** Page-side: render a doc frame offscreen with the shared compositor; returns RGBA of a pixel list. */
export const RENDER_SNIPPET = `
  globalThis.__renderAt = async (doc, t, scale, points) => {
    const { lib } = globalThis.__directorMedia;
    globalThis.__rcomp ??= new lib.Compositor(new OffscreenCanvas(16, 16));
    globalThis.__rtext ??= new lib.TextRenderer();
    globalThis.__rimgs ??= new Map();
    const comp = globalThis.__rcomp;
    await lib.loadLuts(doc, comp);
    const plans = lib.planFrame(doc, t);
    const ready = new Map();
    for (const p of plans) if ((p.kind === 'image') && p.path) {
      let b = globalThis.__rimgs.get(p.path);
      if (!b) { b = await createImageBitmap(await (await fetch(lib.mediaUrl(p.path))).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); globalThis.__rimgs.set(p.path, b); }
      ready.set(p.clip.id, { source: b, width: b.width, height: b.height });
    }
    lib.renderFrame(comp, doc, t, (p) => ready.get(p.clip.id) ?? null, globalThis.__rtext, scale);
    return points.map(([x, y]) => Array.from(comp.readPixels(Math.round(x * comp.width), Math.round(y * comp.height), 1, 1)));
  };
`;
