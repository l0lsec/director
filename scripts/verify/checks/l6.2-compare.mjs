import { assert, vitest, fixture, groundTruth, ffprobe } from '../lib.mjs';
import { launchStudio, call, openProject, speechEdit } from '../swipe-lib.mjs';

// Hand-computed fixture: an edit of 12 s with camera cuts at 4 s and 9 s (3 shots), against the
// reference reel (truth cuts, ffprobe duration). Every delta is computed here, then read from the table.
export default async function () {
  const unit = vitest(['packages/analysis/test/shots.test.ts'], { pattern: 'compares', min: 1 });
  const t = groundTruth().files['reference-reel.mp4'];
  const D = Number(ffprobe(fixture('reference-reel.mp4')).format.duration);
  const refShots = t.cutsAtFrames.length + 1;
  const ref = { durationSec: D, shotCount: refShots, avgShotSec: D / refShots, cutsPerMin: (t.cutsAtFrames.length / D) * 60, firstCutSec: t.cutsAtFrames[0] / 30 };
  const mine = { durationSec: 12, shotCount: 3, avgShotSec: 4, cutsPerMin: 10, firstCutSec: 4 };
  // Displayed as toFixed(0), which rounds halves away from zero (-62.5 shows as -63).
  const pct = (k) => Number((((mine[k] - ref[k]) / ref[k]) * 100).toFixed(0));
  const { app, win } = await launchStudio();
  try {
    const brandId = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const [r] = (await call(win, 'swipe:import', { brandId, paths: [fixture('reference-reel.mp4')] })).added;
    await call(win, 'swipe:analyze', { brandId, id: r.id, transcribe: false });
    await openProject(win);
    await speechEdit(win, { cameraPath: fixture('vertical-1080x1920.mp4'), durationUs: 12_000_000, cameraCuts: [4_000_000, 9_000_000] });
    await win.click('[data-testid="tab-swipe"]');
    await win.click(`.ref-card[data-ref="${r.id}"]`);
    await win.waitForSelector('[data-testid="compare"]');
    const rows = await win.evaluate(() => [...document.querySelectorAll('[data-testid="compare"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)));
    const byLabel = Object.fromEntries(rows.filter((x) => x.length === 4).map((x) => [x[0], x]));
    const notes = rows.filter((x) => x.length === 1).map((x) => x[0]);
    const expect = [['Length', 'durationSec', 's'], ['Shots', 'shotCount', ''], ['Average shot', 'avgShotSec', 's'], ['Cuts per minute', 'cutsPerMin', ''], ['First cut', 'firstCutSec', 's']];
    const problems = [];
    for (const [label, k, u] of expect) {
      const row = byLabel[label];
      if (!row) { problems.push(`${label} missing`); continue; }
      const unit = u ? ' s' : '';
      if (row[1] !== `${mine[k].toFixed(2)}${unit}`) problems.push(`${label} yours ${row[1]} vs ${mine[k].toFixed(2)}`);
      if (row[2] !== `${ref[k].toFixed(2)}${unit}`) problems.push(`${label} reference ${row[2]} vs ${ref[k].toFixed(2)}`);
      const p = pct(k);
      if (row[3] !== `${p > 0 ? '+' : ''}${p}%`) problems.push(`${label} diff ${row[3]} vs ${p}%`);
    }
    if (!notes.some((n) => n.includes(`${pct('avgShotSec')}% longer`))) problems.push(`no "shots run longer" note in ${notes.join(' | ')}`);
    if (!notes.some((n) => n.includes(`${Math.abs(pct('cutsPerMin'))}% less often`))) problems.push(`no "cut less often" note in ${notes.join(' | ')}`);
    if (!notes.some((n) => n.includes(`${(mine.firstCutSec - ref.firstCutSec).toFixed(1)} s later`))) problems.push(`no "first cut later" note in ${notes.join(' | ')}`);
    assert(!problems.length, problems.join('\n'));
    return `${unit}; app compare table: ${expect.map(([l, k]) => `${l} ${pct(k)}%`).join(', ')}, with notes`;
  } finally { await app.close(); }
}
