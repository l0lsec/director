import { assert, vitest, fixture, groundTruth, ffprobe } from '../lib.mjs';
import { launchStudio, libCall, call } from '../swipe-lib.mjs';

const near = (a, b, tol, what) => assert(Math.abs(a - b) <= tol, `${what}: app ${a}, expected ${b} (tolerance ${tol})`);

export default async function () {
  const unit = vitest(['packages/analysis/test/shots.test.ts'], { pattern: 'pacing', min: 2 });
  const g = groundTruth();
  const t = g.files['reference-reel.mp4'];
  const fps = t.fps[0] / t.fps[1];
  const path = fixture('reference-reel.mp4');
  // Independent expectations: truth cut frames, container duration from ffprobe, ground-truth words.
  const D = Number(ffprobe(path).format.duration);
  const bounds = [0, ...t.cutsAtFrames.map((f) => f / fps), D];
  const lens = bounds.slice(1).map((b, i) => b - bounds[i]);
  const sorted = [...lens].sort((a, b) => a - b);
  const want = {
    durationSec: D, shotCount: lens.length, avgShotSec: lens.reduce((a, b) => a + b, 0) / lens.length,
    medianShotSec: sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
    longestShotSec: sorted[sorted.length - 1], cutsPerMin: (t.cutsAtFrames.length / D) * 60, firstCutSec: t.cutsAtFrames[0] / fps,
    wordsPerSec: g.speech.words.length / D,
  };
  const { app, win } = await launchStudio();
  try {
    const brandId = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const [ref] = (await call(win, 'swipe:import', { brandId, paths: [path] })).added;
    await win.click('[data-testid="tab-script"]');
    await win.click('[data-testid="tab-swipe"]');
    await win.click(`.ref-card[data-ref="${ref.id}"]`);
    await win.click('[data-testid="analyze"]');
    await win.waitForSelector('[data-testid="pacing"]', { timeout: 300_000 });
    const a = (await libCall(win, 'swipe.get', brandId, ref.id)).analysis;
    const p = a.pacing;
    assert(a.transcribed, 'reference was not transcribed (is a whisper model installed?)');
    const frame = 1 / fps;
    near(p.durationSec, want.durationSec, 0.001, 'duration');
    assert(p.shotCount === want.shotCount, `shot count ${p.shotCount} vs ${want.shotCount}`);
    near(p.avgShotSec, want.avgShotSec, frame / want.shotCount + 1e-9, 'average shot length');
    near(p.medianShotSec, want.medianShotSec, frame, 'median shot length');
    near(p.longestShotSec, want.longestShotSec, 2 * frame, 'longest shot');
    near(p.cutsPerMin, want.cutsPerMin, 1e-9, 'cuts per minute');
    near(p.firstCutSec, want.firstCutSec, frame, 'first cut');
    // Words come from the app's own transcription (WER about 2%): allow one word either way.
    near(p.wordsPerSec, want.wordsPerSec, 1 / D + 1e-9, 'words per second');
    // The panel shows the same numbers.
    const shown = await win.evaluate(() => [...document.querySelectorAll('[data-testid="pacing"] .stat')].map((s) => s.textContent));
    assert(shown.some((s) => s === `${want.shotCount}Shots`), `panel shows ${shown.join(' / ')}`);
    assert(shown.some((s) => s === `${want.cutsPerMin.toFixed(1)}Cuts / min`), `panel shows ${shown.join(' / ')}`);
    return `${unit}; app: ${p.shotCount} shots, avg ${p.avgShotSec.toFixed(3)} s (expected ${want.avgShotSec.toFixed(3)}), ${p.cutsPerMin.toFixed(2)} cuts/min, first cut ${p.firstCutSec.toFixed(3)} s, ${p.wordsPerSec.toFixed(3)} words/s (expected ${want.wordsPerSec.toFixed(3)})`;
  } finally { await app.close(); }
}
