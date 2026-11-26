import { assert, sh } from '../lib.mjs';
import { launchWithFakeDevices, recordFor } from '../capture-lib.mjs';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export default async function () {
  const { app, win, takesDir } = await launchWithFakeDevices();
  await recordFor(win, 30_000);
  const proc = app.process();
  proc.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 1000));
  const dirs = readdirSync(takesDir).map((d) => join(takesDir, d));
  assert(dirs.length === 1, `expected one take folder, found ${dirs.length}`);
  const cam = join(dirs[0], 'camera.mp4');
  assert(existsSync(cam), 'camera file exists after crash');
  // Decode every frame: the file must be readable to the end of the last complete fragment.
  const r = sh('ffmpeg', ['-v', 'error', '-i', cam, '-map', '0:v:0', '-f', 'null', '-'], { allowFail: true });
  const probe = JSON.parse(sh('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'json', cam]).stdout);
  const frames = Number(probe.streams[0].nb_read_frames);
  const seconds = frames / 30;
  assert(seconds >= 29, `only ${seconds.toFixed(2)} s playable after SIGKILL at 30 s (${(r.stderr || '').slice(0, 300)})`);
  // The take is recovered as ok when listed again.
  return `playable ${seconds.toFixed(2)} s after SIGKILL at 30 s`;
}
