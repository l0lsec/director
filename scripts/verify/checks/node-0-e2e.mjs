import { launchApp, assert, tmp, fixture } from '../lib.mjs';

export default async function () {
  const projects = tmp('node0-projects');
  const env = { DIRECTOR_PROJECTS_DIR: projects };
  const media = fixture('sync-1080p30.mp4');
  let app = await launchApp({ env });
  let dir, expected;
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="tab-record"]');
    const out = await win.evaluate(async (mediaPath) => {
      const call = async (c, p) => { const r = await window.director.invoke(c, p); if (!r.ok) throw new Error(`${c}: ${r.error.message}`); return r.value; };
      const opened = await call('project:create', { name: 'E2E Reel' });
      const probe = await call('media:probe', { path: mediaPath });
      const media = { id: 'media_e2e', path: mediaPath, hash: 'x', name: 'sync', kind: 'video', durationUs: probe.durationUs, width: probe.video.width, height: probe.video.height, fps: probe.video.fps, hasAudio: !!probe.audio, hasVideo: true, addedAt: new Date().toISOString() };
      const cam = opened.doc.lanes.find((l) => l.kind === 'camera').id;
      await call('project:journal', { projectId: opened.doc.id, seq: 1, ops: [{ op: 'addMedia', media }] });
      const clip = { id: 'clip_e2e', kind: 'media', mediaId: 'media_e2e', start: 0, in: 0, out: probe.durationUs, speed: { kind: 'constant', rate: 1, preservePitch: true }, reverse: false, transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false }, blend: 'normal', effects: [], enabled: true };
      await call('project:journal', { projectId: opened.doc.id, seq: 2, ops: [{ op: 'addClip', laneId: cam, clip }] });
      await call('project:save', { projectId: opened.doc.id });
      const list = await call('project:list', {});
      return { dir: opened.dir, id: opened.doc.id, list };
    }, media);
    dir = out.dir;
    assert(out.list.some((p) => p.dir === dir), 'project listed');
    expected = out;
  } finally {
    await app.close();
  }
  app = await launchApp({ env });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="tab-record"]');
    const reopened = await win.evaluate(async (d) => { const r = await window.director.invoke('project:open', { dir: d }); return r; }, dir);
    assert(reopened.ok, `reopen failed: ${JSON.stringify(reopened)}`);
    const doc = reopened.value.doc;
    assert(doc.id === expected.id && doc.name === 'E2E Reel', 'same project');
    assert(doc.media.media_e2e && doc.media.media_e2e.width === 1920, 'media persisted');
    const cam = doc.lanes.find((l) => l.kind === 'camera');
    assert(cam.clips.length === 1 && cam.clips[0].id === 'clip_e2e' && cam.clips[0].out === doc.media.media_e2e.durationUs, 'clip persisted exactly');
  } finally {
    await app.close();
  }
  return `project created, media added, saved, reopened after restart: ${dir}`;
}
