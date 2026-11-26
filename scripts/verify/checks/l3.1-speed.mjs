import { assert, tmp } from '../lib.mjs';
import { launchEditor, importFixtures, fillLane, exportAndWait } from '../edit-lib.mjs';

// A 60 s 1080x1920 reel with camera, voice and 30 caption cards exports in 30 s or less.
export default async function () {
  const out = tmp('export-speed');
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    const [vid, speech] = await importFixtures(win, ['vertical-1080x1920.mp4', 'speech.wav']);
    await fillLane(win, vid, 'camera', 60_000_000, 5_000_000);
    await fillLane(win, speech, 'voice', 60_000_000, 26_000_000);
    await win.evaluate(() => {
      const d = globalThis.__directorProject().doc;
      const lane = d.lanes.find((l) => l.kind === 'captions').id;
      const ops = [];
      for (let i = 0; i < 30; i++) {
        const words = ['STOP', 'TYPING', 'PLAIN', 'PROMPTS'].map((w, k) => ({ text: w, start: k * 450_000, end: k * 450_000 + 400_000 }));
        ops.push({ op: 'addClip', laneId: lane, clip: { id: `cap${i}`, kind: 'caption', start: i * 2_000_000, in: 0, out: 1_900_000, speed: { kind: 'constant', rate: 1, preservePitch: true }, reverse: false, transform: { x: { value: 0 }, y: { value: 520 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false }, blend: 'normal', effects: [], enabled: true, text: { content: words.map((w) => w.text).join(' '), styleId: 'word-pop', font: 'Inter', size: 84, weight: 900, color: '#ffffff', highlightColor: '#f5e23d', align: 'center', lineHeight: 1.05, maxWidth: 0.86, stroke: { color: '#000000', width: 8 }, words } } });
      }
      globalThis.__directorProjectApply(ops, 'captions');
    });
    const t0 = Date.now();
    const job = await exportAndWait(win, 'reels-30', `${out}/reel.mp4`);
    const secs = (Date.now() - t0) / 1000;
    assert(job.status === 'done', `export ${job.status}: ${job.error}`);
    const detail = `60 s reel (camera, voice, 30 captions, loudness pass) exported in ${secs.toFixed(1)} s`;
    assert(Math.abs(job.result.seconds - 60) < 0.05, `duration ${job.result.seconds}`);
    assert(secs <= 30, `too slow: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
