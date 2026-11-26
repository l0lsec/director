import { assert, vitest, fixture } from '../lib.mjs';
import { launchStudio, libCall, call, responses, requestLog } from '../swipe-lib.mjs';

const LABELS = new Set(['hook', 'setup', 'value', 'proof', 'payoff', 'cta', 'other']);
function tiling(segs, D) {
  const p = [];
  if (!segs.length) return ['no segments'];
  if (segs[0].start !== 0) p.push(`starts at ${segs[0].start}`);
  if (Math.abs(segs.at(-1).end - D) > 1e-9) p.push(`ends at ${segs.at(-1).end} not ${D}`);
  segs.forEach((s, i) => {
    if (!(s.end > s.start)) p.push(`segment ${i} empty`);
    if (!LABELS.has(s.label)) p.push(`segment ${i} label ${s.label}`);
    if (typeof s.summary !== 'string') p.push(`segment ${i} summary`);
    if (i && s.start !== segs[i - 1].end) p.push(`${s.start > segs[i - 1].end ? 'gap' : 'overlap'} at ${i}`);
  });
  return p;
}

export default async function () {
  const unit = vitest(['packages/ai/test/ai.test.ts'], { pattern: 'structure labels', min: 4 });
  const R = responses();
  // Recorded responses in order: the reel, then the messy one for the second reference.
  const { app, win, log } = await launchStudio({ replay: { structure: [R.structure.reel, R.structure.messy] } });
  try {
    const brandId = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const refs = (await call(win, 'swipe:import', { brandId, paths: [fixture('reference-reel.mp4'), fixture('cuts-720p.mp4')] })).added;
    const out = [];
    for (const r of refs) {
      await call(win, 'swipe:analyze', { brandId, id: r.id });
      await win.click('[data-testid="tab-script"]');
      await win.click('[data-testid="tab-swipe"]');
      await win.click(`.ref-card[data-ref="${r.id}"]`);
      await win.waitForSelector('[data-testid="label-structure"]:not([disabled])', { timeout: 5_000 }).catch(async () => { throw new Error(`Label button disabled; analyzer: ${await win.evaluate(() => document.querySelector('[data-testid="analyzer"]')?.outerHTML.slice(0, 600))}`); });
      await win.click('[data-testid="label-structure"]');
      await win.waitForSelector('[data-testid="segbar"]', { timeout: 30_000 });
      const a = (await libCall(win, 'swipe.get', brandId, r.id)).analysis;
      const problems = tiling(a.structure.segments, a.durationSec);
      assert(!problems.length, `${r.title}: ${problems.join('; ')}`);
      const bars = await win.evaluate(() => document.querySelectorAll('[data-testid="segbar"] span').length);
      assert(bars === a.structure.segments.length, `segment bar shows ${bars}`);
      out.push(`${r.title}: ${a.structure.segments.length} segments tile 0 to ${a.durationSec.toFixed(2)} s`);
    }
    const reqs = requestLog(log);
    assert(reqs.length === 2 && reqs.every((q) => q.task === 'structure'), `${reqs.length} requests logged`);
    const usage = await call(win, 'claude:status', {});
    assert(usage.usage.calls === 2 && usage.usage.costUsd > 0, 'usage recorded');
    return `${unit}; app (Label structure button, recorded responses): ${out.join('; ')}`;
  } finally { await app.close(); }
}
