// Fake-device capture helpers shared by the 1.1 and 1.4 checks.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sh, fixture, tmp, launchApp, assert } from './lib.mjs';

/** Y4M (fake camera) and WAV (fake mic) derived from the flash/beep sync fixture. */
export function fakeMedia() {
  const dir = join(tmp('fake-media-cache').replace(/fake-media-cache$/, ''), 'fake-media');
  sh('mkdir', ['-p', dir]);
  const y4m = join(dir, 'sync-640x360.y4m');
  const wav = join(dir, 'sync-48k-10s.wav');
  const src = fixture('sync-1080p30.mp4');
  if (!existsSync(y4m)) sh('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vf', 'scale=640:360', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', y4m]);
  // Exactly 10.000 s so the fake mic loop matches the 10.000 s fake camera loop (AAC padding would add 5 ms per loop).
  if (!existsSync(wav)) sh('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '48000', '-af', 'atrim=end_sample=480000', '-c:a', 'pcm_s16le', wav]);
  return { y4m, wav };
}

export async function launchWithFakeDevices(extraEnv = {}) {
  const { y4m, wav } = fakeMedia();
  const takesDir = tmp('takes-' + Math.random().toString(16).slice(2));
  const projects = tmp('projects-' + Math.random().toString(16).slice(2));
  const userData = tmp('userdata-' + Math.random().toString(16).slice(2));
  const app = await launchApp({ env: { DIRECTOR_FAKE_VIDEO: y4m, DIRECTOR_FAKE_AUDIO: wav, DIRECTOR_TAKES_DIR: takesDir, DIRECTOR_PROJECTS_DIR: projects, DIRECTOR_USER_DATA: userData, ...extraEnv } });
  const win = await app.firstWindow();
  await win.waitForSelector('[data-testid="tab-record"]');
  // With first-run onboarding up, Record is already the view behind it; the dialog owns the clicks.
  if (extraEnv.DIRECTOR_ONBOARDING === '1') {
    await win.waitForFunction(() => !!globalThis.__directorRecord, null, { timeout: 20_000 });
    return { app, win, takesDir, projects };
  }
  await win.click('[data-testid="tab-record"]');
  await win.waitForSelector('[data-testid="camera-preview"]', { timeout: 30_000, state: 'attached' }).catch(async (e) => { throw new Error(`camera preview never appeared: ${await win.evaluate(() => document.querySelector('[data-testid=record-workspace]')?.textContent?.slice(0, 400))}`); });
  // Fixed-speed mode avoids starting the speech listener during capture checks.
  await win.evaluate(() => { const r = globalThis.__directorRecord; r.setOption('mode', 'wpm'); r.setOption('countdownSeconds', 0); });
  return { app, win, takesDir, projects };
}

export async function recordFor(win, ms) {
  await win.evaluate(() => globalThis.__directorRecord.startRecording());
  await win.waitForFunction(() => globalThis.__directorRecord.get().phase === 'recording', null, { timeout: 20_000 });
  await new Promise((r) => setTimeout(r, ms));
}

export async function stopAndGet(win) {
  const res = await win.evaluate(() => globalThis.__directorRecord.stopRecording());
  assert(res && res.take, 'stopRecording returned a take');
  return res;
}

/** Times (s) of white flash frames: mean luma jumps above 200. */
export function flashTimes(file) {
  const res = sh('ffmpeg', ['-v', 'error', '-i', file, '-an', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-']);
  const out = res.stdout;
  const times = [];
  let t = null;
  for (const line of out.split('\n')) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) t = Number(m[1]);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && t != null && Number(y[1]) > 200) times.push(t);
  }
  // Keep the first frame of each flash.
  return times.filter((x, i) => i === 0 || x - times[i - 1] > 0.5);
}

/** Times (s) of 1 kHz beep onsets: 5 ms windows whose RMS jumps above -20 dBFS. */
export function beepTimes(file) {
  const res = sh('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-af', 'asetnsamples=n=240:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-']);
  const times = [];
  let t = null;
  for (const line of res.stdout.split('\n')) {
    const m = /pts_time:([\d.]+)/.exec(line);
    if (m) t = Number(m[1]);
    const r = /RMS_level=(-?[\d.]+|-inf)/.exec(line);
    if (r && t != null && r[1] !== '-inf' && Number(r[1]) > -20) times.push(t);
  }
  return times.filter((x, i) => i === 0 || x - times[i - 1] > 0.5);
}

export function frameCount(file) {
  const r = JSON.parse(sh('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames:format=duration', '-of', 'json', file]).stdout);
  return { frames: Number(r.streams[0].nb_read_frames), duration: Number(r.format.duration) };
}

/** Pair each flash with the nearest beep and return offsets (flash minus beep, seconds). */
export function avOffsets(file) {
  const f = flashTimes(file);
  const b = beepTimes(file);
  return f.map((t) => { let best = null; for (const x of b) if (best == null || Math.abs(x - t) < Math.abs(best - t)) best = x; return { t, offset: best == null ? NaN : t - best }; }).filter((x) => Number.isFinite(x.offset) && Math.abs(x.offset) < 0.5);
}
