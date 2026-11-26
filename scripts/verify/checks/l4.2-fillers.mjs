import { assert, groundTruth } from '../lib.mjs';
import { launchEditor, speechProject } from '../edit-lib.mjs';

export default async function () {
  const g = groundTruth().speechGaps;
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    await speechProject(win, 'speech-gaps.wav');
    await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'effects' }));
    await win.waitForFunction(() => !!globalThis.__directorAutoCut);
    const flagged = await win.evaluate(() => globalThis.__directorAutoCut.plan().filter((r) => r.reason === 'filler').map((r) => ({ from: r.from, to: r.to })));
    const truth = g.words.filter((w) => g.fillers.includes(w.text)).map((w) => ({ from: w.start * 1e6, to: w.end * 1e6 }));
    const overlaps = (a, b) => a.from < b.to && b.from < a.to;
    const tp = truth.filter((t) => flagged.some((f) => overlaps(f, t))).length;
    const fpos = flagged.filter((f) => !truth.some((t) => overlaps(f, t))).length;
    const recall = tp / truth.length;
    const precision = flagged.length ? (flagged.length - fpos) / flagged.length : 0;
    const detail = `fillers: ${truth.length} in the fixture, ${flagged.length} flagged, recall ${(recall * 100).toFixed(0)}%, precision ${(precision * 100).toFixed(0)}%`;
    assert(recall >= 0.9 && precision >= 0.9, detail);
    return detail;
  } finally { await app.close(); }
}
