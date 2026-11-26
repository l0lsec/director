import { assert, vitest, groundTruth } from '../lib.mjs';
import { launchEditor, speechProject } from '../edit-lib.mjs';

export default async function () {
  const unit = vitest(['packages/analysis/test/m4.test.ts'], { min: 1, pattern: 'removes every pause' });
  const g = groundTruth().speechGaps;
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    await speechProject(win, 'speech-gaps.wav');
    await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'effects' }));
    await win.waitForFunction(() => !!globalThis.__directorAutoCut);
    const r = await win.evaluate(async () => {
      // 0.5 s threshold: the fixture has a 0.34 s pause right at the 0.35 s default, where any real
      // transcription's boundary jitter decides the outcome. No fixture pause lies within 0.15 s of 0.5 s.
      globalThis.__directorAutoCut.setOptions({ fillers: false, minPause: 500_000 });
      await new Promise((x) => setTimeout(x, 100));
      globalThis.__directorAutoCut.apply();
      await new Promise((x) => setTimeout(x, 100));
      const d = globalThis.__directorProject().doc;
      const words = globalThis.__directorMakeReel ? null : null;
      void words;
      const v = d.lanes.find((l) => l.kind === 'voice').clips;
      const end = Math.max(...v.map((c) => c.start + (c.out - c.in)));
      return { end, clips: v.length };
    });
    const us = (s) => Math.round(s * 1e6);
    const keep = 80_000, min = 500_000;
    let expected = us(g.durationSec);
    expected -= us(g.words[0].start) - keep;
    expected -= us(g.durationSec) - us(g.words[g.words.length - 1].end) - keep;
    for (let i = 0; i < g.words.length - 1; i++) { const gap = us(g.words[i + 1].start) - us(g.words[i].end); if (gap > min) expected -= gap - 2 * keep; }
    const frame = 1_000_000 / 30;
    const detail = `real transcription: ${r.clips} pieces, ${(r.end / 1e6).toFixed(3)} s vs ground-truth expectation ${(expected / 1e6).toFixed(3)} s (${((r.end - expected) / 1000).toFixed(0)} ms)`;
    assert(Math.abs(r.end - expected) <= 2 * frame, `duration off: ${detail}`);
    return `${unit}; ${detail}`;
  } finally { await app.close(); }
}
