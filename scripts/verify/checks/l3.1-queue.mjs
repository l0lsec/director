import { assert, tmp } from '../lib.mjs';
import { launchEditor, importFixtures, fillLane } from '../edit-lib.mjs';
import { existsSync, readdirSync } from 'node:fs';

export default async function () {
  const out = tmp('queue');
  const { app, win } = await launchEditor({ preset: 'landscape-1080', env: { DIRECTOR_EXPORT_DIR: out } });
  try {
    const [m] = await importFixtures(win, ['sync-1080p30.mp4']);
    await fillLane(win, m, 'camera', 30_000_000, 10_000_000);
    const [a, b] = await win.evaluate((dir) => {
      const d = globalThis.__directorProject().doc;
      return [globalThis.__directorExport.enqueueExport(d, 'youtube-1080', `${dir}/first.mp4`, { loudness: false }), globalThis.__directorExport.enqueueExport(d, 'youtube-1080', `${dir}/second.mp4`, { loudness: false })];
    }, out);
    // Keep editing while the first export renders.
    await win.waitForFunction((id) => globalThis.__directorExport.jobs().find((j) => j.id === id)?.status === 'rendering', a, { timeout: 60_000 });
    const edits = await win.evaluate(async () => {
      let n = 0;
      for (let i = 0; i < 20; i++) {
        globalThis.__directorEditCmd.seek(i * 1_000_000);
        globalThis.__directorEditCmd.addMarker();
        n++;
        await new Promise((r) => setTimeout(r, 50));
      }
      return n;
    });
    await win.evaluate((id) => globalThis.__directorExport.cancelExport(id), b);
    await win.waitForFunction((id) => ['done', 'error'].includes(globalThis.__directorExport.jobs().find((j) => j.id === id)?.status), a, { timeout: 300_000 });
    const jobs = await win.evaluate(() => globalThis.__directorExport.jobs());
    const ja = jobs.find((j) => j.id === a), jb = jobs.find((j) => j.id === b);
    assert(ja.status === 'done', `first export ${ja.status}: ${ja.error}`);
    assert(jb.status === 'cancelled', `second export ${jb.status}`);
    assert(!existsSync(`${out}/second.mp4`) && !readdirSync(out).some((f) => f.includes('second') && f.includes('partial')), 'cancelled export left no files');
    const markers = await win.evaluate(() => globalThis.__directorProject().doc.markers.length);
    assert(markers === 20, `edits during export: ${markers} markers`);
    const hist = await win.evaluate(async () => (await window.director.invoke('export:history', {})).value);
    assert(hist[0] && hist[0].path.endsWith('first.mp4') && hist[0].preset === 'youtube-1080', `history ${JSON.stringify(hist[0])}`);
    return `export ran while ${edits} edits were made; queued export cancelled cleanly; history lists ${hist.length}`;
  } finally { await app.close(); }
}
