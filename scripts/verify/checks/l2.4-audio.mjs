import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';

// Render the mix offline through the same graph the preview uses and compare levels with the math.
export default async function () {
  const { app, win } = await launchEditor();
  try {
    const [tone] = await importFixtures(win, ['tone-440.wav']);
    await addToTimeline(win, tone, 0, 'music');
    await addToTimeline(win, tone, 5_000_000, 'music');
    const r = await win.evaluate(async () => {
      const d0 = globalThis.__directorProject().doc;
      const music = d0.lanes.find((l) => l.kind === 'music');
      const [c1, c2] = music.clips;
      globalThis.__directorProjectApply([
        { op: 'updateClip', id: c1.id, patch: { audio: { ...c1.audio, gainDb: { value: -6 }, fadeIn: 1_000_000 } } },
        { op: 'updateClip', id: c2.id, patch: { audio: { ...c2.audio, gainDb: { value: 0 }, pan: -1 } } },
      ], 'mix');
      const doc = globalThis.__directorProject().doc;
      const { lib } = globalThis.__directorMedia;
      const pool = new lib.MediaPool();
      const ctx = new OfflineAudioContext(2, 48000 * 9, 48000);
      const cache = new lib.AudioCache(pool, (ch, len, rate) => new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }));
      await lib.buildMix(ctx, doc, cache, { fromUs: 0, startAt: 0 });
      const out = await ctx.startRendering();
      const rms = (ch, a, b) => { const d = out.getChannelData(ch); let s = 0; const i0 = Math.round(a * 48000), i1 = Math.round(b * 48000); for (let i = i0; i < i1; i++) s += d[i] * d[i]; return Math.sqrt(s / (i1 - i0)); };
      return { fade: rms(0, 0.0, 1.0), steady: rms(0, 1.5, 3.5), panL: rms(0, 5.5, 8.5), panR: rms(1, 5.5, 8.5), steadyR: rms(1, 1.5, 3.5) };
    });
    const db = (x) => 20 * Math.log10(x);
    const base = 0.5 / Math.SQRT2; // RMS of a 0.5-amplitude sine
    const checks = [
      ['steady -6 dB', r.steady, base * Math.pow(10, -6 / 20)],
      ['steady right channel (mono to stereo)', r.steadyR, base * Math.pow(10, -6 / 20)],
      ['linear fade-in over 1 s', r.fade, base * Math.pow(10, -6 / 20) / Math.sqrt(3)],
      ['pan hard left: left', r.panL, base],
    ];
    const lines = [];
    for (const [name, got, want] of checks) {
      const diff = db(got) - db(want);
      lines.push(`${name}: ${db(got).toFixed(2)} dBFS vs ${db(want).toFixed(2)} (${diff.toFixed(2)} dB)`);
      assert(Math.abs(diff) <= 0.5, `${name} off by ${diff.toFixed(2)} dB`);
    }
    assert(r.panR < 1e-3, `pan hard left leaks into right: ${r.panR}`);
    return lines.join('; ');
  } finally { await app.close(); }
}
