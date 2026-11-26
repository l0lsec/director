import { assert, tmp } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline, exportAndWait } from '../edit-lib.mjs';

export default async function () {
  const out = tmp('loudness');
  const results = [];
  // Quiet speech, and a loud tone bed, both must land on -14 LUFS with true peak at or below -1 dBTP.
  for (const [name, setup] of [['speech', ['speech.wav']], ['speech+tone', ['speech.wav', 'tone-440.wav']]]) {
    const { app, win } = await launchEditor({ preset: 'vertical-1080' });
    try {
      const ids = await importFixtures(win, setup);
      await addToTimeline(win, ids[0], 0, 'voice');
      if (ids[1]) for (let t = 0; t < 26e6; t += 4e6) await addToTimeline(win, ids[1], t, 'music');
      const job = await exportAndWait(win, 'reels-30', `${out}/${name}.mp4`);
      assert(job.status === 'done', `${name}: ${job.status} ${job.error ?? ''}`);
      const l = await win.evaluate((p) => window.director.invoke('export:loudness', { path: p }).then((r) => r.value), `${out}/${name}.mp4`);
      results.push(`${name}: ${l.integrated} LUFS, true peak ${l.truePeak} dBTP`);
      assert(Math.abs(l.integrated - -14) <= 1, `${name} integrated ${l.integrated}`);
      assert(l.truePeak <= -1, `${name} true peak ${l.truePeak}`);
    } finally { await app.close(); }
  }
  return results.join('; ');
}
