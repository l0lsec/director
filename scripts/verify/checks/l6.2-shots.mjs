import { assert, vitest, fixture, groundTruth } from '../lib.mjs';
import { launchStudio, libCall, call } from '../swipe-lib.mjs';

// Scored here, independently of the app's scoreCuts: greedy one-to-one matching within one frame.
function score(detected, truth) {
  const used = new Set();
  let hit = 0, maxErr = 0;
  for (const d of detected) {
    const k = truth.findIndex((t, i) => !used.has(i) && Math.abs(t - d) <= 1);
    if (k >= 0) { used.add(k); hit++; maxErr = Math.max(maxErr, Math.abs(truth[k] - d)); }
  }
  return { precision: detected.length ? hit / detected.length : 0, recall: hit / truth.length, maxErr };
}

export default async function () {
  const unit = vitest(['packages/analysis/test/shots.test.ts'], { pattern: 'shot detection', min: 4 });
  const gt = groundTruth().files;
  const { app, win } = await launchStudio();
  try {
    const brandId = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const names = ['reference-reel.mp4', 'cuts-720p.mp4'];
    const refs = (await call(win, 'swipe:import', { brandId, paths: names.map((n) => fixture(n)) })).added;
    const out = [];
    for (const [i, name] of names.entries()) {
      const r = refs[i];
      await win.click('[data-testid="tab-script"]');
      await win.click('[data-testid="tab-swipe"]');
      await win.click(`.ref-card[data-ref="${r.id}"]`);
      await win.click('[data-testid="analyze"]');
      await win.waitForSelector('[data-testid="pacing"]', { timeout: 180_000 });
      const a = (await libCall(win, 'swipe.get', brandId, r.id)).analysis;
      const t = gt[name];
      const fps = t.fps[0] / t.fps[1];
      const s = score(a.cuts.map((c) => Math.round(c * fps)), t.cutsAtFrames);
      assert(s.precision >= 0.95 && s.recall >= 0.95 && s.maxErr <= 1, `${name}: precision ${s.precision}, recall ${s.recall}, max error ${s.maxErr} frames; detected ${a.cuts.map((c) => Math.round(c * fps)).join(',')}`);
      out.push(`${name} P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)} max ${s.maxErr} frame`);
      await win.waitForSelector('[data-testid="pacing"]');
      await win.click(`.ref-card[data-ref="${refs[(i + 1) % refs.length].id}"]`);
    }
    return `${unit}; app (Analyze button): ${out.join('; ')}`;
  } finally { await app.close(); }
}
