import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline, readBarcode } from '../edit-lib.mjs';

// Speed ramp, freeze frame and reverse: rendered frames carry exactly the source frame the engine predicts.
export default async function () {
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [sync] = await importFixtures(win, ['sync-1080p30.mp4']);
    await addToTimeline(win, sync, 0, 'camera');
    const misses = [];
    const check = async (label, cases) => {
      for (const { t, frame } of cases) {
        await win.evaluate((tt) => globalThis.__directorPlayer.seek(tt), t);
        const got = await readBarcode(win);
        if (got !== frame) misses.push(`${label} t=${t}: frame ${got}, expected ${frame}`);
      }
    };
    const predict = () => win.evaluate(() => {
      const E = globalThis.__directorEngine;
      const d = globalThis.__directorProject().doc;
      const clips = d.lanes.find((l) => l.kind === 'camera').clips;
      const end = Math.max(...clips.map((c) => E.clipEnd(c)));
      const cases = [];
      for (let k = 0; k < 24; k++) {
        const t = Math.round((end * (k + 0.37)) / 24);
        const c = clips.find((x) => x.start <= t && t < E.clipEnd(x));
        if (!c) continue;
        cases.push({ t, frame: E.microsToFrame(E.sourceTimeAt(c, t), { num: 30, den: 1 }) });
      }
      return { cases, end, kinds: clips.map((c) => (c.freezeAt != null ? 'freeze' : c.speed.kind)) };
    });
    // 1. Hero ramp.
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; const c = d.lanes.find((l) => l.kind === 'camera').clips[0]; globalThis.__directorProjectApply(globalThis.__directorEngine.setRampOps(d, c.id, 'hero', true), 'ramp'); });
    const ramp = await predict();
    // Hero ramp averages 0.58x (area under 1 -> 0.3 -> 0.3 -> 1), so 10 s of source plays for 10 / 0.58 s.
    assert(Math.abs(ramp.end - 10e6 / 0.58) < 40_000, `ramped duration ${ramp.end}`);
    await check('hero ramp', ramp.cases);
    // 2. Back to 1x, freeze at 2.5 s for 1 s.
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; const c = d.lanes.find((l) => l.kind === 'camera').clips[0]; let d2 = globalThis.__directorAnalysisApply(d, globalThis.__directorEngine.setRampOps(d, c.id, null, true)); globalThis.__directorProjectApply(globalThis.__directorEngine.setRampOps(d, c.id, null, true), 'flat'); const d3 = globalThis.__directorProject().doc; globalThis.__directorProjectApply(globalThis.__directorEngine.freezeFrameOps(d3, c.id, 2_500_000, 1_000_000), 'freeze'); void d2; });
    const fr = await predict();
    assert(fr.kinds.join() === 'constant,freeze,constant' && Math.abs(fr.end - 11e6) < 1000, `freeze layout ${fr.kinds} end ${fr.end}`);
    await check('freeze', [...fr.cases, { t: 2_600_000, frame: 75 }, { t: 3_400_000, frame: 75 }, { t: 3_600_000, frame: 78 }]);
    // 3. Reverse the last piece.
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; const c = d.lanes.find((l) => l.kind === 'camera').clips[2]; globalThis.__directorProjectApply(globalThis.__directorEngine.reverseOps(d, c.id), 'reverse'); });
    const rev = await predict();
    await check('reverse', rev.cases.filter((x) => x.t >= 3_500_000));
    assert(misses.length === 0, misses.join('\n'));
    return `ramp ${ramp.cases.length}, freeze ${fr.cases.length + 3}, reverse ${rev.cases.filter((x) => x.t >= 3_500_000).length} frames all exact; ramped clip lasts ${(ramp.end / 1e6).toFixed(2)} s`;
  } finally { await app.close(); }
}
