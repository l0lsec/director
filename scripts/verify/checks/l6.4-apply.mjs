import { assert, vitest, fixture, groundTruth } from '../lib.mjs';
import { launchStudio, responses, directorProject, docJson } from '../swipe-lib.mjs';

const dur = (win) => win.evaluate(() => { const d = globalThis.__directorProject().doc; return Math.max(0, ...d.lanes.flatMap((l) => l.clips.map((c) => c.start + (c.out - c.in) / (c.speed.rate ?? 1)))); });

export default async function () {
  const unit = vitest(['packages/ai/test/ai.test.ts'], { pattern: 'edit director', min: 4 });
  const R = responses();
  const { app, win } = await launchStudio({ replay: { director: [R.director.valid, R.director.valid] }, tab: 'edit' });
  try {
    const gt = groundTruth();
    await directorProject(win, gt, fixture);
    const before = await docJson(win);
    const d0 = await dur(win);
    // Pass 1: everything Claude proposed.
    await win.click('[data-testid="run-director"]');
    await win.waitForSelector('[data-testid="director-proposal"]', { timeout: 30_000 });
    const rows = await win.evaluate(() => [...document.querySelectorAll('[data-testid="director-proposal"] [data-action]')].map((r) => ({ label: r.querySelector('.col span').textContent, reason: r.querySelector('.hint').textContent, checked: r.querySelector('input').checked })));
    assert(rows.length === 7 && rows.every((r) => r.checked && r.reason.length > 3), `preview rows ${JSON.stringify(rows)}`);
    assert(rows[0].label === 'Cut 3.6 to 4.7 s (1.1 s)' || /^Cut 3\.6/.test(rows[0].label), `first row ${rows[0].label}`);
    const summary = await win.textContent('[data-testid="director-proposal"] p.hint');
    assert(/26\.8 s to 23\.7 s/.test(summary) && /3 cuts, 1 zooms, 1 b-roll, 1 titles, 1 notes/.test(summary), `preview summary: ${summary}`);
    assert((await docJson(win)) === before, 'the preview changed the project');
    const undos0 = await win.evaluate(() => globalThis.__directorProject().undoLabel);
    await win.click('[data-testid="apply-director"]');
    await win.waitForFunction(() => /^Director:/.test(globalThis.__directorProject().undoLabel ?? ''), null, { timeout: 10_000 })
      .catch(async () => { throw new Error(`not applied; panel says: ${await win.evaluate(() => [...document.querySelectorAll('[data-testid="director-panel"] .err, .toast')].map((e) => e.textContent).join(' | '))}; undo label ${await win.evaluate(() => globalThis.__directorProject().undoLabel)}`); });
    const d1 = await dur(win);
    assert(Math.abs(d0 - d1 - 3_150_000) <= 1, `removed ${(d0 - d1) / 1e6} s, expected 3.15`);
    const doc = await win.evaluate(() => globalThis.__directorProject().doc);
    const lane = (k) => doc.lanes.find((l) => l.kind === k);
    assert(lane('broll').clips.length === 1 && lane('titles').clips.length === 1 && doc.markers.some((m) => m.label === 'Consider a stronger CTA'), 'b-roll, title or marker missing');
    assert(lane('camera').clips.some((c) => c.effects.some((e) => e.type === 'zoom' && e.params.until > e.params.at)), 'zoom with release missing');
    const words = await win.evaluate(() => globalThis.__directorAnalysis.timelineWords(globalThis.__directorProject().doc).length);
    assert(words === gt.speech.words.length, `${words} words survive, expected all ${gt.speech.words.length}`);
    // One undo restores the project exactly.
    await win.evaluate(() => globalThis.__directorUndo());
    assert((await docJson(win)) === before, 'one undo did not restore the project exactly');
    assert((await win.evaluate(() => globalThis.__directorProject().undoLabel)) === undos0, 'undo stack not back where it was');
    // Pass 2: keep only the cuts.
    await win.click('[data-testid="run-director"]');
    await win.waitForSelector('[data-testid="director-proposal"]', { timeout: 30_000 });
    for (const i of [3, 4, 5, 6]) await win.uncheck(`[data-action="${i}"] input`);
    await win.click('[data-testid="apply-director"]');
    await win.waitForFunction(() => /^Director:/.test(globalThis.__directorProject().undoLabel ?? ''));
    const doc2 = await win.evaluate(() => globalThis.__directorProject().doc);
    assert(doc2.lanes.find((l) => l.kind === 'broll').clips.length === 0 && doc2.lanes.find((l) => l.kind === 'titles').clips.length === 0, 'unchecked actions were applied');
    assert(Math.abs(d0 - (await dur(win)) - 3_150_000) <= 1, 'cuts only: wrong duration');
    await win.evaluate(() => globalThis.__directorUndo());
    assert((await docJson(win)) === before, 'undo of the subset did not restore');
    return `${unit}; app: 7 previewed edits applied as one transaction (26.8 s to 23.7 s, every word kept), one undo restores byte-identical; a cuts-only subset applies and undoes the same way`;
  } finally { await app.close(); }
}
