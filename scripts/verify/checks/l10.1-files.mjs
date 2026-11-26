import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, vitest, fixture, tmp } from '../lib.mjs';
import { launchStudio, openProject, stage } from '../swipe-lib.mjs';

// The Files panel against a content folder laid out by category, the way people keep one.
const LAYOUT = [
  ['sync-1080p30.mp4', 'A-Roll/Interview take 1.mp4'],
  ['reference-reel.mp4', 'B-Roll/Drone/coast.mp4'],
  ['cuts-720p.mp4', 'B-Roll/City 2.mp4'],
  ['vertical-1080x1920.mp4', 'B-Roll/City 10.mp4'],
  ['tone-440.wav', 'Music/bed.wav'],
  ['click-120bpm.wav', 'SFX/whoosh.wav'],
  ['speech.wav', 'Voiceover/vo.wav'],
  ['still.png', 'Images/logo.png'],
];

const doc = (win) => win.evaluate(() => globalThis.__directorProject().doc);
const undoLabel = (win) => win.evaluate(() => globalThis.__directorProject().undoLabel);
const rows = (win) => win.evaluate(() => globalThis.__directorFiles.rows());
/** Clips on the timeline that come from a file name, with their lane kind and start (seconds). */
async function placed(win, name) {
  const d = await doc(win);
  const out = [];
  for (const l of d.lanes) for (const c of l.clips) { const m = c.mediaId && d.media[c.mediaId]; if (m && m.path.endsWith(`/${name}`)) out.push({ lane: l.kind, start: c.start / 1e6, role: m.role }); }
  return out;
}
const waitPlaced = (win, name, n = 1) => win.waitForFunction(({ name, n }) => {
  const d = globalThis.__directorProject().doc;
  let k = 0;
  for (const l of d.lanes) for (const c of l.clips) { const m = c.mediaId && d.media[c.mediaId]; if (m && m.path.endsWith(`/${name}`)) k++; }
  return k >= n;
}, { name, n }, { timeout: 30_000 });

export default async function () {
  const unit = [vitest(['packages/engine/test/files.test.ts'], { min: 6 }), vitest(['apps/desktop/test/unit/browse.test.ts'], { min: 6 })].join('; ');
  const content = tmp('files-content');
  stage(content, LAYOUT.map(([src, name]) => [fixture(src), name]));
  writeFileSync(join(content, 'notes.txt'), 'shot list');
  const row = (rel) => `.fb-row[data-path="${content}/${rel}"]`;
  let first = await launchStudio({ tab: 'edit' });
  let { app, win } = first;
  const notes = [];
  try {
    await openProject(win);
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, content);
    await win.click('.edit-left [role="tab"]:has-text("Files")');
    await win.click('[data-testid="files-open"]');
    await win.waitForSelector(row('B-Roll'));
    assert(JSON.stringify(await rows(win)) === JSON.stringify(['A-Roll', 'B-Roll', 'Images', 'Music', 'SFX', 'Voiceover']), `top level ${await rows(win)}`);
    const status = await win.textContent('[data-testid="files-status"]');
    assert(status.includes('6 items') && status.includes('1 other file hidden'), `status "${status}"`);

    // Expand B-Roll: folders first, numbers in order; thumbnails load.
    await win.dblclick(row('B-Roll'));
    await win.waitForSelector(row('B-Roll/City 10.mp4'));
    const broll = (await rows(win)).filter((r) => r.startsWith('B-Roll/'));
    assert(JSON.stringify(broll) === JSON.stringify(['B-Roll/Drone', 'B-Roll/City 2.mp4', 'B-Roll/City 10.mp4']), `B-Roll order ${broll}`);
    await win.waitForSelector(`${row('B-Roll/City 2.mp4')} .fb-thumb[data-loaded="1"]`, { timeout: 20_000 });

    // Preview: selecting a file plays it in the panel.
    await win.click(row('B-Roll/City 2.mp4'));
    await win.waitForFunction(() => { const v = document.querySelector('[data-testid="files-preview-media"]'); return v && v.tagName === 'VIDEO' && v.readyState >= 1 && v.duration > 0; }, null, { timeout: 15_000 });
    notes.push('preview plays');

    // Double-click: imported and placed at the playhead on B-roll as one undo step.
    await win.evaluate(() => { globalThis.__directorEditCmd.setEdit({ snapping: false }); globalThis.__directorEditCmd.seek(2_000_000); });
    await win.waitForFunction(() => globalThis.__directorEditCmd.getEdit().t === 2_000_000);
    const before = await doc(win);
    await win.dblclick(row('B-Roll/City 2.mp4'));
    await waitPlaced(win, 'City 2.mp4');
    let p = await placed(win, 'City 2.mp4');
    assert(p.length === 1 && p[0].lane === 'broll' && Math.abs(p[0].start - 2) < 0.001 && p[0].role === 'broll', `double-click ${JSON.stringify(p)}`);
    assert((await undoLabel(win)) === 'Add City 2.mp4', `undo label ${await undoLabel(win)}`);
    await win.evaluate(() => globalThis.__directorUndo());
    const undone = await doc(win);
    assert(Object.keys(undone.media).length === Object.keys(before.media).length && undone.lanes.every((l) => l.clips.length === before.lanes.find((b) => b.id === l.id).clips.length), 'one undo did not take back both the import and the clip');
    await win.evaluate(() => globalThis.__directorRedo());
    await win.waitForSelector(`${row('B-Roll/City 2.mp4')} .fb-in`);

    // Keyboard: Right expands, Down moves, Enter adds (Music folder sends it to the Music lane).
    assert((await win.evaluate(() => globalThis.__directorEditCmd.getEdit().t)) === 2_000_000, 'the playhead moved');
    await win.click(row('Music'));
    await win.keyboard.press('ArrowRight');
    await win.waitForSelector(row('Music/bed.wav'));
    await win.keyboard.press('ArrowDown');
    await win.keyboard.press('Enter');
    await waitPlaced(win, 'bed.wav');
    p = await placed(win, 'bed.wav');
    assert(p[0].lane === 'music' && Math.abs(p[0].start - 2) < 0.001, `Enter ${JSON.stringify(p)}`);

    // Folder guess on a project without an SFX lane: the lane is created, and it is all one step.
    const sfx = (await doc(win)).lanes.find((l) => l.kind === 'sfx');
    await win.evaluate((id) => globalThis.__directorProjectApply([{ op: 'removeLane', id }], 'Remove SFX lane'), sfx.id);
    await win.dblclick(row('SFX'));
    await win.dblclick(row('SFX/whoosh.wav'));
    await waitPlaced(win, 'whoosh.wav');
    p = await placed(win, 'whoosh.wav');
    assert(p[0].lane === 'sfx', `SFX guess ${JSON.stringify(p)}`);
    await win.evaluate(() => globalThis.__directorUndo());
    assert(!(await doc(win)).lanes.some((l) => l.kind === 'sfx'), 'undo left the new SFX lane behind');
    await win.evaluate(() => globalThis.__directorRedo());

    // Right-click > Add to lane > Camera overrides the folder guess.
    await win.click(row('B-Roll/City 10.mp4'), { button: 'right' });
    await win.waitForSelector('[data-testid="context-menu"]');
    const items = await win.evaluate(() => globalThis.__directorMenu.items());
    for (const want of ['Add at the playhead', 'Add to the end', 'Add to lane', 'Import to Media', 'Reveal in Finder', 'Copy path']) assert(items.includes(want), `menu lacks ${want}: ${items}`);
    await win.hover('[data-testid="context-menu"] [data-id="add-lane"]');
    await win.waitForSelector('[data-testid="context-submenu"] [data-id="lane-camera"]');
    const sub = await win.$$eval('[data-testid="context-submenu"] [role="menuitem"]', (els) => els.map((e) => e.textContent));
    assert(sub.join('|') === 'Camera|Screen|B-rollsuggested', `lane submenu ${sub}`);
    await win.click('[data-testid="context-submenu"] [data-id="lane-camera"]');
    await waitPlaced(win, 'City 10.mp4');
    p = await placed(win, 'City 10.mp4');
    assert(p[0].lane === 'camera' && p[0].role === 'camera', `lane choice ${JSON.stringify(p)}`);
    assert(!(await win.$('[data-testid="context-menu"]')), 'menu stayed open after a choice');

    // Keyboard menu: Shift+F10 opens it on the focused row, Escape closes it.
    await win.focus(row('B-Roll/City 10.mp4'));
    await win.keyboard.press('Shift+F10');
    await win.waitForSelector('[data-testid="context-menu"]');
    await win.keyboard.press('Escape');
    await win.waitForSelector('[data-testid="context-menu"]', { state: 'detached' });

    // Import only: into the Media bin, nothing on the timeline, then marked as in the project.
    await win.dblclick(row('Images'));
    const clipsBefore = (await doc(win)).lanes.reduce((n, l) => n + l.clips.length, 0);
    await win.click(row('Images/logo.png'), { button: 'right' });
    await win.click('[data-testid="context-menu"] [data-id="import"]');
    await win.waitForSelector(`${row('Images/logo.png')} .fb-in`, { timeout: 20_000 });
    const afterImport = await doc(win);
    assert(Object.values(afterImport.media).some((m) => m.path.endsWith('/logo.png')) && afterImport.lanes.reduce((n, l) => n + l.clips.length, 0) === clipsBefore, 'import only changed the timeline');

    // Drag a file onto the B-roll lane at 10 s.
    await win.dblclick(row('B-Roll/Drone'));
    await win.waitForSelector(row('B-Roll/Drone/coast.mp4'));
    const geo = await win.evaluate(() => {
      const head = [...document.querySelectorAll('.lane-head')].find((h) => h.querySelector('.name')?.textContent === 'B-roll');
      const canvas = document.querySelector('[data-testid="timeline"] canvas');
      const { zoom, scrollX } = globalThis.__directorEditCmd.getEdit ? globalThis.__directorEditCmd.getEdit() : { zoom: 80, scrollX: 0 };
      const hr = head.getBoundingClientRect(), cr = canvas.getBoundingClientRect();
      return { x: 10 * zoom - scrollX, y: hr.top - cr.top + hr.height / 2, w: cr.width };
    });
    assert(geo.x > 0 && geo.x < geo.w, `10 s is off the visible timeline (${JSON.stringify(geo)})`);
    await win.dragAndDrop(row('B-Roll/Drone/coast.mp4'), '[data-testid="timeline"] canvas', { targetPosition: { x: geo.x, y: geo.y } });
    await waitPlaced(win, 'coast.mp4');
    p = await placed(win, 'coast.mp4');
    assert(p[0].lane === 'broll' && Math.abs(p[0].start - 10) < 0.1, `drag ${JSON.stringify(p)}`);
    notes.push(`drag landed at ${p[0].start.toFixed(2)} s on B-roll`);

    // Search below the folder, filter by kind, select all results and add them to the end of their lanes.
    await win.fill('[data-testid="files-search"]', 'drone');
    await win.waitForFunction(() => globalThis.__directorFiles.rows().join() === 'B-Roll/Drone/coast.mp4');
    await win.click('.files .lib-filters button:has-text("Audio")');
    await win.waitForFunction(() => globalThis.__directorFiles.rows().length === 0);
    await win.fill('[data-testid="files-search"]', 'wav');
    await win.waitForFunction(() => globalThis.__directorFiles.rows().length === 3);
    await win.focus(`${row('Music/bed.wav')}`);
    await win.keyboard.press('Meta+a');
    const voiceEnd = (await doc(win)).lanes.find((l) => l.kind === 'voice').clips.reduce((t, c) => Math.max(t, (c.start + (c.out - c.in)) / 1e6), 0);
    await win.keyboard.press('Shift+Enter');
    await waitPlaced(win, 'vo.wav');
    assert((await undoLabel(win)) === 'Add 3 files', `multi undo label ${await undoLabel(win)}`);
    p = await placed(win, 'vo.wav');
    assert(p[0].lane === 'voice' && Math.abs(p[0].start - voiceEnd) < 0.001, `Voiceover to the end of Voice ${JSON.stringify(p)} (lane ended at ${voiceEnd})`);
    assert((await placed(win, 'bed.wav')).length === 2 && (await placed(win, 'whoosh.wav')).length === 2, 'multi add missed a file');
    const bedMedia = Object.values((await doc(win)).media).filter((m) => m.path.endsWith('/bed.wav'));
    assert(bedMedia.length === 1, 'the same file was imported twice');

    // Folder action: Add all of A-Roll to the end of the Camera lane.
    await win.fill('[data-testid="files-search"]', '');
    await win.click('.files .lib-filters button:has-text("All")');
    await win.waitForSelector(row('A-Roll'));
    await win.click(row('A-Roll'), { button: 'right' });
    await win.click('[data-testid="context-menu"] [data-id="folder-add"]');
    await waitPlaced(win, 'Interview take 1.mp4');
    p = await placed(win, 'Interview take 1.mp4');
    assert(p[0].lane === 'camera', `A-Roll folder ${JSON.stringify(p)}`);

    // A file that lands in the folder appears without a refresh.
    copyFileSync(fixture('click-120bpm.wav'), join(content, 'SFX', 'riser 2.wav'));
    await win.waitForSelector(row('SFX/riser 2.wav'), { timeout: 10_000 });
    notes.push('new file appeared live');

    // The agent tool sees the same folder, suggests lanes, and cannot leave it.
    const listed = await win.evaluate(() => globalThis.__directorAgent.run('browse_files', {}));
    const data = listed.data ?? listed;
    assert(data.entries?.map((e) => e.name).join() === 'A-Roll,B-Roll,Images,Music,SFX,Voiceover' && data.otherFilesHidden === 1, `browse_files ${JSON.stringify(listed).slice(0, 400)}`);
    const found = await win.evaluate(() => globalThis.__directorAgent.run('browse_files', { query: 'whoosh' }));
    const hit = (found.data ?? found).results?.[0];
    assert(hit && hit.suggestedRole === 'sfx' && hit.suggestedLane === 'sfx' && hit.inProject === true && hit.path.endsWith('/SFX/whoosh.wav'), `browse_files search ${JSON.stringify(found).slice(0, 400)}`);
    const out = await win.evaluate(() => globalThis.__directorAgent.run('browse_files', { folder: '/private/etc' }));
    assert(out.ok === false && out.error.code === 'OUTSIDE_ROOTS', `outside the folder: ${JSON.stringify(out).slice(0, 300)}`);
    const sneaky = await win.evaluate((p) => globalThis.__directorAgent.run('browse_files', { folder: p }), `${content}/../`);
    assert(sneaky.ok === false && sneaky.error.code === 'OUTSIDE_ROOTS', `traversal: ${JSON.stringify(sneaky).slice(0, 300)}`);

    // Layout: the preview's buttons stay inside the panel, for a folder and for a video.
    for (const pick of [row('A-Roll'), row('B-Roll/City 2.mp4')]) {
      await win.click(pick);
      const fit = await win.evaluate(() => { const a = document.querySelector('.edit-left').getBoundingClientRect(); const b = [...document.querySelectorAll('.fb-pv-actions button')].map((x) => x.getBoundingClientRect()); return b.length > 0 && b.every((r) => r.bottom <= a.bottom + 0.5 && r.right <= a.right + 0.5); });
      assert(fit, `preview buttons spill out of the panel for ${pick}`);
    }
    await win.screenshot({ path: process.env.DIRECTOR_SHOT ?? join(tmp('files-shot'), 'files.png') });
    if (process.env.DIRECTOR_SHOT) {
      await win.click(row('B-Roll/City 2.mp4'), { button: 'right' });
      await win.hover('[data-testid="context-menu"] [data-id="add-lane"]');
      await win.waitForSelector('[data-testid="context-submenu"]');
      await win.screenshot({ path: process.env.DIRECTOR_SHOT.replace(/\.png$/, '-menu.png'), clip: { x: 0, y: 200, width: 700, height: 500 } });
      await win.keyboard.press('Escape');
    }
  } finally { await app.close(); }

  // Relaunch on the same profile: the folder is still open.
  ({ app, win } = await launchStudio({ tab: 'edit', env: { DIRECTOR_USER_DATA: first.userData } }));
  try {
    await win.click('.edit-left [role="tab"]:has-text("Files")');
    await win.waitForSelector(row('B-Roll'), { timeout: 20_000 });
    assert((await win.inputValue('[data-testid="files-root"]')) === content, 'the opened folder was not remembered');
  } finally { await app.close(); }
  return `${unit}; app: tree in Finder order with ${'thumbnails'}, ${notes.join(', ')}; double-click, Enter, Shift+Enter, right-click lane, folder guess (new SFX lane), folder add and drag each one undo step; import only; search and kind filter; browse_files lists, suggests lanes and refuses outside the folder; remembered after relaunch`;
}
