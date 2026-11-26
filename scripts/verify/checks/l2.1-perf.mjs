import { assert } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';

// 3 video layers (camera, screen, b-roll) and 4 audio tracks at 1080p30, 60 s of playback.
export default async function () {
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [sync, vert, cuts, speech, tone, click] = await importFixtures(win, ['sync-1080p30.mp4', 'vertical-1080x1920.mp4', 'cuts-720p.mp4', 'speech.wav', 'tone-440.wav', 'click-120bpm.wav']);
    // Fill 62 s on each lane by repeating clips back to back.
    const fill = async (id, lane, dur) => { for (let t = 0; t < 62e6; t += dur) await addToTimeline(win, id, t, lane); };
    await fill(sync, 'camera', 10e6);
    await fill(cuts, 'screen', 10e6);
    await fill(vert, 'broll', 5e6);
    await fill(speech, 'voice', 26e6);
    await fill(tone, 'music', 4e6);
    await fill(click, 'sfx', 10e6);
    await win.evaluate(async () => {
      const d = globalThis.__directorProject().doc;
      const apply = (ops, l) => globalThis.__directorProjectApply(ops, l);
      // Put screen and b-roll in picture-in-picture so all three layers are visible.
      const ops = [];
      for (const lane of d.lanes) for (const c of lane.clips) {
        if (lane.kind === 'screen') ops.push({ op: 'updateClip', id: c.id, patch: { transform: { ...c.transform, scale: { value: 0.45 }, x: { value: -480 }, y: { value: -260 } } } });
        if (lane.kind === 'broll') ops.push({ op: 'updateClip', id: c.id, patch: { transform: { ...c.transform, scale: { value: 0.3 }, x: { value: 600 }, y: { value: 200 } }, fit: 'contain' } });
      }
      apply(ops, 'pip');
    });
    const result = await win.evaluate(async () => {
      const p = globalThis.__directorPlayer;
      p.scale = 1;
      await p.prepare();
      await p.seek(0);
      p.resetStats();
      await p.play();
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 60_000));
      p.pause();
      return { ...p.stats, elapsed: performance.now() - t0, t: p.time };
    });
    const ratio = result.framesLate / Math.max(1, result.framesDrawn);
    const detail = `drew ${result.framesDrawn} frames in ${(result.elapsed / 1000).toFixed(1)} s, late ${result.framesLate} (${(ratio * 100).toFixed(2)}%), reached ${(result.t / 1e6).toFixed(1)} s`;
    assert(result.t > 58e6, `playback stalled: ${detail}`);
    assert(ratio <= 0.01, `too many late frames: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
