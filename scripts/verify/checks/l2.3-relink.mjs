import { assert, fixture, tmp, sh } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';
import { join } from 'node:path';
import { copyFileSync, mkdirSync, renameSync } from 'node:fs';

export default async function () {
  const dir = tmp('relink');
  const original = join(dir, 'original', 'my take.mp4');
  mkdirSync(join(dir, 'original'), { recursive: true });
  mkdirSync(join(dir, 'moved', 'deep'), { recursive: true });
  copyFileSync(fixture('vertical-1080x1920.mp4'), original);
  copyFileSync(fixture('sync-1080p30.mp4'), join(dir, 'moved', 'decoy.mp4'));
  const { app, win } = await launchEditor();
  let projectDir;
  try {
    await win.evaluate((p) => globalThis.__directorLibrary.importPaths([p]), original);
    projectDir = await win.evaluate(() => globalThis.__directorProject().dir);
    await win.evaluate(() => globalThis.__directorProject && window.director.invoke('project:save', { projectId: globalThis.__directorProject().doc.id }));
  } finally { await app.close(); }
  renameSync(original, join(dir, 'moved', 'deep', 'renamed.mp4'));
  const again = await launchEditor();
  try {
    const w = again.win;
    await w.evaluate(async (d) => { await window.director.invoke('settings:set', { key: 'lastProjectDir', value: d }); }, projectDir);
    // Reopen the same project and check media.
    await w.evaluate(async (d) => { const r = await window.director.invoke('project:open', { dir: d }); return r.ok; }, projectDir);
    const res = await w.evaluate(async (d) => {
      const store = globalThis.__directorProject;
      // Open through the app store so the library sees it.
      const opened = await window.director.invoke('project:open', { dir: d });
      return opened.value.doc.media;
    }, projectDir);
    const m = Object.values(res)[0];
    assert(m, 'media persisted');
    const found = await w.evaluate(async ({ hash, root }) => (await window.director.invoke('media:relink', { hash, dirs: [root] })).value, { hash: m.hash, root: join(dir, 'moved') });
    assert(found && found.endsWith('renamed.mp4'), `relink found ${found}`);
    return `moved and renamed file found by content hash: ${found.split('/').slice(-3).join('/')} (decoy ignored)`;
  } finally { await again.app.close(); }
}
