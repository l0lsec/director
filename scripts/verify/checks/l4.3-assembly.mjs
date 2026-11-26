import { assert, groundTruth, vitest } from '../lib.mjs';
import { launchEditor, speechProject } from '../edit-lib.mjs';

// Real transcription of a reading with a false start, an ad-lib and a repeated line.
export default async function () {
  const unit = vitest(['packages/analysis/test/m4.test.ts'], { min: 1, pattern: 'keeps each line once' });
  const g = groundTruth().retakes;
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    await speechProject(win, 'retakes.wav', { script: g.lines.join('\n') });
    const r = await win.evaluate(() => {
      const A = globalThis.__directorAnalysis;
      const E = globalThis.__directorAnalysisApply;
      const doc = globalThis.__directorProject().doc;
      const words = A.timelineWords(doc);
      const end = Math.max(...doc.lanes.flatMap((l) => l.clips.map((c) => c.start + (c.out - c.in))));
      const { parseScript } = globalThis.__directorEngine;
      const plan = A.planBestTake(parseScript(doc.scriptText), words, doc.markers, end);
      const after = E(doc, A.cutOps(doc, plan.cuts));
      return { chosen: plan.chosen.map((a) => [a.line, a.start]), missing: plan.missingLines, text: A.timelineWords(after).map((w) => w.text).join(' ') };
    });
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const want = norm(g.lines.join(' '));
    const got = norm(r.text).replace(/\b3\b/g, 'three');
    assert(r.missing.length === 0, `lines not found: ${r.missing}`);
    const keeps = g.takes.filter((t) => t.kind === 'keep');
    r.chosen.forEach(([line, start], i) => assert(Math.abs(start / 1e6 - keeps[i].start) < 0.3, `line ${line} took the take at ${(start / 1e6).toFixed(2)} s, expected ${keeps[i].start.toFixed(2)} s`));
    assert(!/honestly/.test(got), 'ad-lib removed');
    // Compare word by word, forgiving transcription spellings ("claud" for "claude"): assembly errors
    // show up as missing, extra or repeated words, which change the count or break the alignment.
    const gw = got.split(' '), ww = want.split(' ');
    const close = (a, b) => a === b || (a.length > 3 && b.length > 3 && (a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4))));
    assert(gw.length === ww.length && gw.every((w, i) => close(w, ww[i])), `result reads:\n${got}\nexpected:\n${want}`);
    return `${unit}; real transcription: 6/6 lines from their last complete takes, ad-lib and false start removed`;
  } finally { await app.close(); }
}
