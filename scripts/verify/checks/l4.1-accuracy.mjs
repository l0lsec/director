import { assert, groundTruth } from '../lib.mjs';
import { launchEditor, speechProject } from '../edit-lib.mjs';

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export default async function () {
  const gt = groundTruth().speech;
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    await speechProject(win, 'speech.wav');
    const words = await win.evaluate(() => globalThis.__directorProject().doc.transcript[0].words);
    const hyp = words.map((w) => norm(w.text)).filter(Boolean);
    const ref = gt.words.map((w) => norm(w.text));
    const wer = editDistance(hyp, ref) / ref.length;
    // Word-start error over words whose text matches, in order.
    const errs = [];
    let j = 0;
    for (const w of words) {
      const n = norm(w.text);
      const k = ref.indexOf(n, j);
      if (k < 0 || k - j > 3) continue;
      errs.push(Math.abs(w.start / 1e6 - gt.words[k].start) * 1000);
      j = k + 1;
    }
    errs.sort((a, b) => a - b);
    const median = errs[Math.floor(errs.length / 2)];
    const detail = `WER ${(wer * 100).toFixed(1)}% over ${ref.length} words; word-start error median ${median.toFixed(0)} ms, p90 ${errs[Math.floor(errs.length * 0.9)].toFixed(0)} ms (${errs.length} matched)`;
    assert(wer <= 0.05, `WER too high: ${detail}`);
    assert(median <= 80, `timing too loose: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
