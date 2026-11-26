import { assert, tmp, sh, fixture } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';
import { join } from 'node:path';

// Strict form: one minute of speech with large-v3-turbo in 10 s or less.
export default async function () {
  const model = process.env.DIRECTOR_SPEED_MODEL ?? 'large-v3-turbo';
  const dir = tmp('tspeed-' + model);
  const minute = join(dir, 'minute.wav');
  sh('ffmpeg', ['-v', 'error', '-y', '-i', fixture('speech.wav'), '-i', fixture('speech-gaps.wav'), '-i', fixture('speech.wav'), '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1,atrim=0:60', minute]);
  const { app, win } = await launchEditor();
  try {
    const r = await win.evaluate(async ({ path, model }) => window.director.invoke('transcribe:run', { path, model, force: true }), { path: minute, model });
    assert(r.ok, `transcription failed: ${r.error?.message}`);
    const detail = `${r.value.seconds.toFixed(1)} s of speech transcribed with ${r.value.model} in ${(r.value.elapsedMs / 1000).toFixed(2)} s (${r.value.words.length} words)`;
    assert(r.value.seconds >= 59 && r.value.elapsedMs <= 10_000, `too slow: ${detail}`);
    return detail;
  } finally { await app.close(); }
}
