import { assert } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet } from '../capture-lib.mjs';

// Script -> prompter -> record (with a retake and cues) -> Send to editor -> synced lanes and markers.
export default async function () {
  const { app, win } = await launchWithFakeDevices();
  try {
    await win.evaluate(() => { const r = globalThis.__directorRecord; r.setScript('[HOOK] One two three four five.\n[ZOOM] Six seven eight nine ten.\n[CTA] Eleven twelve thirteen.'); r.setOption('wpm', 300); });
    const [prompter] = await Promise.all([app.waitForEvent('window'), win.evaluate(() => globalThis.__directorRecord.openPrompter('overlay'))]);
    await prompter.waitForSelector('[data-testid="prompter"]');
    await recordFor(win, 1500);
    const words = await prompter.evaluate(() => document.querySelectorAll('.w.read').length);
    assert(words > 0, 'prompter shows words as read during recording');
    await win.evaluate(() => globalThis.__directorRecord.handleKey('R'));
    await new Promise((r) => setTimeout(r, 2500));
    const res = await stopAndGet(win);
    assert(res.take.markers.some((m) => m.kind === 'retake'), 'retake marker');
    assert(res.take.markers.filter((m) => m.kind === 'cue').length >= 2, 'cue markers');
    await win.evaluate((e) => globalThis.__directorRecord.sendToEditor(e), res);
    const p = await win.evaluate(() => globalThis.__directorProject());
    const cam = p.doc.lanes.find((l) => l.kind === 'camera').clips[0];
    const voice = p.doc.lanes.find((l) => l.kind === 'voice').clips[0];
    assert(cam && voice && cam.start === voice.start, 'synced lanes');
    assert(p.doc.markers.some((m) => m.kind === 'retake') && p.doc.markers.some((m) => m.kind === 'cue'), 'markers on the timeline');
    return `take ${res.take.id}: ${res.take.markers.length} markers carried to the timeline; prompter read ${words} words`;
  } finally { await app.close(); }
}
