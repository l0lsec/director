import { join } from 'node:path';
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { assert, sh, tmp, fixture, groundTruth, ensurePackaged } from '../lib.mjs';

const CLEAN = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
const isSystem = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/');

/** Every image dyld loaded for a run, from DYLD_PRINT_LIBRARIES. */
function loaded(stderr) {
  return [...stderr.matchAll(/^dyld\[\d+\]: <[^>]+> (\S+)/gm)].map((m) => m[1]);
}

export default async function () {
  const app = ensurePackaged();
  const res = join(app, 'Contents', 'Resources');
  const bundle = realpathSync(res);
  // 1. No Mach-O file in the bundle references Homebrew or /usr/local.
  const machO = [...readdirSync(join(res, 'bin')).map((f) => join(res, 'bin', f)), ...readdirSync(join(res, 'lib')).map((f) => join(res, 'lib', f))];
  const refs = [];
  for (const f of machO) {
    for (const l of sh('otool', ['-L', f]).stdout.split('\n').slice(1)) {
      const d = l.trim().split(' (')[0];
      if (d && (d.startsWith('/opt/') || d.startsWith('/usr/local/'))) refs.push(`${f.split('/').pop()} -> ${d}`);
    }
    if (readFileSync(f).includes('/opt/homebrew/Cellar/ggml')) refs.push(`${f.split('/').pop()} embeds the Homebrew ggml path`);
  }
  assert(!refs.length, refs.join('\n'));
  // 2. Each sidecar runs with Homebrew off PATH, and dyld loads nothing outside the bundle and the OS.
  const outside = [];
  const runs = { ffmpeg: ['-hide_banner', '-version'], ffprobe: ['-version'], 'whisper-cli': ['--help'], 'director-native': ['version'] };
  for (const [name, args] of Object.entries(runs)) {
    const r = sh(join(res, 'bin', name), args, { env: { ...CLEAN, DYLD_PRINT_LIBRARIES: '1' }, allowFail: true });
    if (name !== 'director-native') assert(r.status === 0, `${name} failed: ${r.stderr.slice(-300)}`);
    for (const p of loaded(r.stderr)) if (!isSystem(p) && !realpathSync(p).startsWith(bundle)) outside.push(`${name}: ${p}`);
  }
  assert(!outside.length, `loaded from outside the bundle:\n${outside.join('\n')}`);
  // 3. They do real work: H.264 encode on VideoToolbox, probe, and a transcription on the bundled ggml backends.
  const work = tmp('l7.2-sidecars');
  const mp4 = join(work, 'enc.mp4');
  sh(join(res, 'bin', 'ffmpeg'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', '-c:v', 'h264_videotoolbox', '-b:v', '2M', mp4], { env: CLEAN });
  const probe = JSON.parse(sh(join(res, 'bin', 'ffprobe'), ['-v', 'error', '-print_format', 'json', '-show_streams', mp4], { env: CLEAN }).stdout);
  assert(probe.streams[0].codec_name === 'h264' && probe.streams[0].nb_frames === '30', `encode/probe: ${JSON.stringify(probe.streams[0]).slice(0, 160)}`);
  const model = [join(homedir(), '.cache', 'whisper', 'ggml-small.en.bin'), join(homedir(), '.cache', 'whisper', 'ggml-base.en.bin')].find(existsSync);
  assert(model, 'no whisper model in ~/.cache/whisper to test with');
  const wav = join(work, 'speech16k.wav');
  sh(join(res, 'bin', 'ffmpeg'), ['-v', 'error', '-y', '-i', fixture('speech.wav'), '-ac', '1', '-ar', '16000', wav], { env: CLEAN });
  const tr = sh(join(res, 'bin', 'whisper-cli'), ['-m', model, '-f', wav, '-nt', '-np'], { env: { ...CLEAN, DYLD_PRINT_LIBRARIES: '1' }, allowFail: true, timeout: 300_000 });
  assert(tr.status === 0, `whisper failed: ${tr.stderr.slice(-400)}`);
  const backends = loaded(tr.stderr).filter((p) => /libggml-(metal|cpu|blas)/.test(p));
  assert(backends.length && backends.every((p) => realpathSync(p).startsWith(bundle)), `ggml backends: ${backends.join(', ')}`);
  for (const p of loaded(tr.stderr)) if (!isSystem(p) && !realpathSync(p).startsWith(bundle)) outside.push(`whisper (transcribing): ${p}`);
  assert(!outside.length, outside.join('\n'));
  const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean);
  const heard = norm(tr.stdout);
  const truth = norm(groundTruth().speech.words.map((w) => w.text).join(' '));
  const hit = truth.filter((w) => heard.includes(w)).length / truth.length;
  assert(hit >= 0.9, `transcript matched ${(hit * 100).toFixed(0)}% of words: ${tr.stdout.slice(0, 200)}`);
  // 4. The app itself, run with only its bundle allowed, resolves and uses them.
  const { _electron } = await import('@playwright/test');
  const home = tmp('l7.2-sidecars-home');
  const el = await _electron.launch({ executablePath: join(app, 'Contents', 'MacOS', 'Director'), args: [], env: { ...CLEAN, HOME: home, DIRECTOR_USER_DATA: join(home, 'ud'), DIRECTOR_PROJECTS_DIR: join(home, 'p'), DIRECTOR_BUNDLED_ONLY: '1' } });
  try {
    const win = await el.firstWindow();
    await win.waitForSelector('[data-testid="onboarding"]', { timeout: 30_000 });
    const p = await win.evaluate((f) => window.director.invoke('media:probe', { path: f }), fixture('reference-reel.mp4'));
    assert(p.ok && p.value.video.width === 720 && p.value.audio, `in-app probe: ${JSON.stringify(p).slice(0, 200)}`);
    const v = await win.evaluate(() => window.director.invoke('native:version', {}));
    assert(v.ok && v.value.name === 'director-native', `native helper: ${JSON.stringify(v).slice(0, 200)}`);
  } finally { await el.close(); }
  return `${machO.length} Mach-O files reference nothing in Homebrew; ffmpeg, ffprobe, whisper-cli and director-native run with Homebrew off PATH and dyld loads only bundled or system images; VideoToolbox encode, probe, and a ${backends.length}-backend whisper transcription (${(hit * 100).toFixed(0)}% of words) work from the bundle; the app probes media and talks to its native helper with only its bundle allowed`;
}
