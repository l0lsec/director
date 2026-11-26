import { assert, fixture, groundTruth } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';

export default async function () {
  const g = groundTruth().files['click-120bpm.wav'];
  const truth = [];
  for (let t = g.firstBeatSec; t < g.durationSec; t += 60 / g.bpm) truth.push(t);
  const { app, win } = await launchEditor();
  try {
    const beats = await win.evaluate(async (p) => (await window.director.invoke('audio:beats', { path: p })).value, fixture('click-120bpm.wav'));
    const errs = truth.map((t) => Math.min(...beats.map((b) => Math.abs(b - t))) * 1000);
    const extras = beats.filter((b) => !truth.some((t) => Math.abs(b - t) < 0.05)).length;
    const worst = Math.max(...errs);
    const detail = `${beats.length} beats for ${truth.length} clicks; worst error ${worst.toFixed(1)} ms; extras ${extras}`;
    assert(worst <= 20 && extras === 0 && beats.length === truth.length, detail);
    return detail;
  } finally { await app.close(); }
}
