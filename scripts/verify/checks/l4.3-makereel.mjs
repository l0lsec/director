import { assert, groundTruth } from '../lib.mjs';
import { launchEditor, speechProject, importFixtures, fillLane } from '../edit-lib.mjs';

export default async function () {
  const g = groundTruth().retakes;
  const script = g.lines.map((l, i) => (i === 2 ? `[ZOOM] ${l}` : i === 3 ? `[B-ROLL: phone screen] ${l}` : l)).join('\n');
  // Cue markers as the recorder writes them (at the cue's line start in the take).
  const keeps = g.takes.filter((t) => t.kind === 'keep');
  const markers = [
    { id: 'cz', t: Math.round(keeps[2].start * 1e6) - 50_000, kind: 'cue', label: 'ZOOM' },
    { id: 'cb', t: Math.round(keeps[3].start * 1e6) - 50_000, kind: 'cue', label: 'BROLL: phone screen' },
  ];
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    // Camera footage under the voice so the [ZOOM] cue has a picture to punch into.
    const [cam] = await importFixtures(win, ['vertical-1080x1920.mp4']);
    await fillLane(win, cam, 'camera', Math.round(g.durationSec * 1e6), 5_000_000);
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; globalThis.__directorProjectApply(d.lanes.find((l) => l.kind === 'camera').clips.map((c) => ({ op: 'updateClip', id: c.id, patch: { audio: { ...c.audio, muted: true } } })), 'mute camera'); });
    await speechProject(win, 'retakes.wav', { script, markers });
    const before = await win.evaluate(() => JSON.stringify(globalThis.__directorProject().doc));
    const report = await win.evaluate(() => globalThis.__directorMakeReel.makeReel());
    const d = await win.evaluate(() => globalThis.__directorProject().doc);
    const words = await win.evaluate(() => globalThis.__directorAnalysis.timelineWords(globalThis.__directorProject().doc));
    assert(d.canvas.width === 1080 && d.canvas.height === 1920, `canvas ${d.canvas.width}x${d.canvas.height}`);
    let maxGap = 0;
    for (let i = 0; i < words.length - 1; i++) maxGap = Math.max(maxGap, words[i + 1].start - words[i].end);
    assert(maxGap <= 400_000, `pause of ${(maxGap / 1e6).toFixed(2)} s remains`);
    const caps = d.lanes.find((l) => l.kind === 'captions').clips;
    assert(caps.length >= 8, `${caps.length} captions`);
    const zoomed = d.lanes.find((l) => l.kind === 'camera').clips.filter((c) => c.effects.some((e) => e.type === 'zoom'));
    assert(report.zooms === 1 && zoomed.length === 1, `zooms ${report.zooms}`);
    // The zoom starts at the cued line's first word ("Give").
    const give = words.find((w) => /^give$/i.test(w.text));
    const fx = zoomed[0].effects.find((e) => e.type === 'zoom');
    assert(give && Math.abs(zoomed[0].start + fx.params.at - give.start) < 50_000, `zoom at ${zoomed[0].start + fx.params.at}, "Give" at ${give?.start}`);
    const broll = d.lanes.find((l) => l.kind === 'broll').clips.filter((c) => c.kind === 'placeholder');
    const voiceZoom = report.zooms;
    assert(broll.length === 1 && /phone screen/.test(broll[0].name), `b-roll placeholders: ${JSON.stringify(broll.map((b) => b.name))}`);
    // The zoom cue lands on the Camera lane; this project has audio only, so the zoom count reflects that.
    // Independent expectation: at least the bad takes and the ad-lib (from ground truth) are gone.
    const junk = g.takes.filter((t) => t.kind !== 'keep').reduce((n, t) => n + (t.end - t.start) * 1e6, 0);
    assert(report.captions === caps.length && report.removedUs >= junk, `removed ${(report.removedUs / 1e6).toFixed(2)} s, junk takes ${(junk / 1e6).toFixed(2)} s: ${JSON.stringify(report)}`);
    const label = await win.evaluate(() => globalThis.__directorProject && window.director && document.querySelector('[data-testid="edit-workspace"]') ? 'ok' : 'ok');
    void label;
    await win.evaluate(() => globalThis.__directorUndo());
    const undone = await win.evaluate(() => JSON.stringify(globalThis.__directorProject().doc));
    assert(undone === before, 'one undo restores the project exactly');
    return `Make Reel: ${(report.before / 1e6).toFixed(1)} s -> ${(report.after / 1e6).toFixed(1)} s, ${report.captions} captions, ${broll.length} b-roll placeholder, zooms ${voiceZoom}, longest pause ${(maxGap / 1e6).toFixed(2)} s, undone in one step`;
  } finally { await app.close(); }
}
