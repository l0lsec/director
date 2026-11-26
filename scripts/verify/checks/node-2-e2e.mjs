import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline, readBarcode } from '../edit-lib.mjs';

const S = 1_000_000;

// Scripted edit through the real UI commands, then frames checked against the source frame the edit math predicts.
export default async function () {
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [sync, tone] = await importFixtures(win, ['sync-1080p30.mp4', 'tone-440.wav']);
    await addToTimeline(win, sync, 0, 'camera');
    await addToTimeline(win, tone, 0, 'music');
    // Split at 3 s, select the right part, ripple-trim its first second, set it to 2x, music to -6 dB.
    await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ selection: [], ripple: true }));
    await win.evaluate(() => globalThis.__directorEditCmd.seek(3_000_000));
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; globalThis.__directorEditCmd.setEdit({ selection: [d.lanes.find((l) => l.kind === 'camera').clips[0].id] }); });
    await win.keyboard.press('Meta+b');
    await win.evaluate(() => { const cam = globalThis.__directorProject().doc.lanes.find((l) => l.kind === 'camera').clips; globalThis.__directorEditCmd.setEdit({ selection: [cam[1].id] }); });
    await win.evaluate(() => globalThis.__directorEditCmd.seek(4_000_000));
    await win.keyboard.press('q'); // trim start to playhead (ripple): right part now starts at 3 s with source 4 s
    await win.evaluate(() => globalThis.__directorEditCmd.setSpeed(2));
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; const m = d.lanes.find((l) => l.kind === 'music').clips[0]; globalThis.__directorProjectApply([{ op: 'updateClip', id: m.id, patch: { audio: { ...m.audio, gainDb: { value: -6 } } } }], 'music level'); });
    const cam = await win.evaluate(() => globalThis.__directorProject().doc.lanes.find((l) => l.kind === 'camera').clips.map((c) => ({ start: c.start, in: c.in, out: c.out, rate: c.speed.rate })));
    assert(JSON.stringify(cam) === JSON.stringify([{ start: 0, in: 0, out: 3 * S, rate: 1 }, { start: 3 * S, in: 4 * S, out: 10 * S, rate: 2 }]), `camera clips ${JSON.stringify(cam)}`);
    const expectFrame = (t) => (t < 3 * S ? Math.floor((t / S) * 30) : Math.floor(((4 * S + (t - 3 * S) * 2) / S) * 30 + 1e-6));
    const misses = [];
    for (const t of [500_000, 1_516_000, 2_950_000, 3_016_000, 3_517_000, 4_250_000, 5_016_000, 5_900_000]) {
      await win.evaluate((tt) => globalThis.__directorPlayer.seek(tt), t);
      const got = await readBarcode(win);
      if (got !== expectFrame(t)) misses.push(`t=${t}: frame ${got}, expected ${expectFrame(t)}`);
    }
    assert(misses.length === 0, misses.join('\n'));
    const level = await win.evaluate(async () => {
      const { lib } = globalThis.__directorMedia;
      // Mute the camera's own beeps so the measurement isolates the music level.
      const d0 = globalThis.__directorProject().doc;
      globalThis.__directorProjectApply(d0.lanes.find((l) => l.kind === 'camera').clips.map((c) => ({ op: 'updateClip', id: c.id, patch: { audio: { ...c.audio, muted: true } } })), 'mute camera');
      const doc = globalThis.__directorProject().doc;
      const ctx = new OfflineAudioContext(2, 48000 * 3, 48000);
      await lib.buildMix(ctx, doc, new lib.AudioCache(new lib.MediaPool(), (c, l, r) => new AudioBuffer({ numberOfChannels: c, length: l, sampleRate: r })), { fromUs: 0, startAt: 0 });
      const out = await ctx.startRendering();
      const d = out.getChannelData(0); let s = 0; for (let i = 24000; i < 120000; i++) s += d[i] * d[i];
      return 20 * Math.log10(Math.sqrt(s / 96000));
    });
    // A 0.5-amplitude tone at -6 dB is -15.03 dBFS RMS.
    assert(Math.abs(level - -15.03) < 0.5, `mix level ${level.toFixed(2)} dBFS`);
    return `split + ripple trim + 2x speed: 8/8 frames exact; music mix ${level.toFixed(2)} dBFS`;
  } finally { await app.close(); }
}
