import { assert, vitest, fixture, groundTruth } from '../lib.mjs';
import { launchStudio, responses, directorProject, docJson } from '../swipe-lib.mjs';

export default async function () {
  const unit = vitest(['packages/ai/test/ai.test.ts'], { pattern: 'rejects invalid', min: 1 });
  const R = responses();
  const { app, win } = await launchStudio({ replay: { director: [R.director.invalid, R.director.badType] }, tab: 'edit' });
  try {
    await directorProject(win, groundTruth(), fixture);
    const before = await docJson(win);
    const undoBefore = await win.evaluate(() => globalThis.__directorProject().undoLabel);
    assert(undoBefore === 'transcript', `setup undo label ${undoBefore}`);
    // 1. A plan with out-of-range and invalid actions: every problem listed, nothing selected, nothing applied.
    await win.click('[data-testid="run-director"]');
    await win.waitForSelector('[data-testid="director-proposal"]', { timeout: 30_000 });
    const reasons = await win.evaluate(() => [...document.querySelectorAll('[data-testid="director-proposal"] [role="alert"] li')].map((l) => l.textContent));
    for (const re of [/past the end of the timeline/, /zoom amount 3 is outside/, /cut through the word "typing"/, /needs text/]) assert(reasons.some((r) => re.test(r)), `no reason matching ${re} in: ${reasons.join(' | ')}`);
    assert(reasons.length === 4, `${reasons.length} reasons`);
    const checked = await win.evaluate(() => [...document.querySelectorAll('[data-testid="director-proposal"] input[type="checkbox"]')].filter((c) => c.checked).length);
    assert(checked === 0, `${checked} actions preselected`);
    assert(await win.isDisabled('[data-testid="apply-director"]'), 'apply is enabled for an invalid plan');
    // Selecting an invalid action by hand still applies nothing (all or nothing).
    await win.check('[data-action="4"] input');
    await win.check('[data-action="0"] input');
    assert(await win.isDisabled('[data-testid="apply-director"]'), 'apply enabled with an invalid action selected');
    const viaApi = await win.evaluate(() => globalThis.__directorDirector.applyDirector([
      { type: 'marker', start: 2, end: 2, text: 'fine', amount: 0, reason: 'valid' },
      { type: 'cut', start: 25, end: 31, text: '', amount: 0, reason: 'past the end' },
    ], new Set([0, 1]), 'mixed'));
    assert(!viaApi.ok && viaApi.problems.some((p) => /past the end/.test(p.reason)), 'mixed plan applied');
    assert((await docJson(win)) === before, 'the project changed after rejected plans');
    // 2. An unknown action type fails schema validation before anything is compiled.
    await win.click('[data-testid="run-director"]');
    await win.waitForSelector('[data-testid="director-panel"] .err[role="alert"]', { timeout: 30_000 });
    const err = await win.textContent('[data-testid="director-panel"] .err[role="alert"]');
    assert(/does not match the expected shape/.test(err), `error shown: ${err}`);
    assert((await docJson(win)) === before, 'the project changed after an invalid response');
    assert((await win.evaluate(() => globalThis.__directorProject().undoLabel)) === undoBefore, 'an undo step was added');
    return `${unit}; app: 4 invalid actions rejected with reasons (none selectable into an apply), a mixed plan refused whole, an unknown action type rejected by the schema; project byte-identical and no undo step added`;
  } finally { await app.close(); }
}
