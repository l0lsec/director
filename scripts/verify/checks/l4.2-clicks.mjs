import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';

// Cut a continuous tone at points that are not zero crossings; with the 10 ms fades there must be no jump.
export default async function () {
  const { app, win } = await launchEditor();
  try {
    const [tone] = await importFixtures(win, ['tone-440.wav']);
    await addToTimeline(win, tone, 0, 'voice');
    const r = await win.evaluate(async () => {
      const { lib } = globalThis.__directorMedia;
      const ana = globalThis.__directorAnalysis;
      const d0 = globalThis.__directorProject().doc;
      const cuts = [{ from: 501_234, to: 800_777, reason: 'pause', label: 'a' }, { from: 1_700_111, to: 1_950_013, reason: 'pause', label: 'b' }, { from: 2_400_321, to: 2_600_999, reason: 'pause', label: 'c' }];
      const render = async (doc) => {
        const ctx = new OfflineAudioContext(1, 48000 * 3, 48000);
        await lib.buildMix(ctx, doc, new lib.AudioCache(new lib.MediaPool(), (c, l, rr) => new AudioBuffer({ numberOfChannels: c, length: l, sampleRate: rr })), { fromUs: 0, startAt: 0 });
        return (await ctx.startRendering()).getChannelData(0);
      };
      const measure = (x, points) => {
        let worst = 0;
        for (const p of points) { const i0 = Math.round((p / 1e6) * 48000); for (let i = i0 - 240; i < i0 + 240; i++) if (i > 0 && i < x.length) worst = Math.max(worst, Math.abs(x[i] - x[i - 1])); }
        return worst;
      };
      const points = []; let removed = 0; for (const c of cuts) { points.push(c.from - removed); removed += c.to - c.from; }
      const withFade = await render(globalThis.__directorAnalysisApply(d0, ana.cutOps(d0, cuts, 10_000)));
      const noFade = await render(globalThis.__directorAnalysisApply(d0, ana.cutOps(d0, cuts, 0)));
      return { withFade: measure(withFade, points), noFade: measure(noFade, points), natural: 2 * Math.PI * 440 / 48000 * 0.5 };
    });
    const detail = `largest sample step at cuts: ${r.withFade.toFixed(4)} with 10 ms fades vs ${r.noFade.toFixed(4)} without (a clean 440 Hz tone steps at most ${r.natural.toFixed(4)})`;
    assert(r.noFade > 0.1, `control: unfaded cuts should click (${detail})`);
    assert(r.withFade <= r.natural * 1.5, `clicks remain: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
