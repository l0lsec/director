#!/usr/bin/env node
// Deterministic fixture media. Everything is generated from ffmpeg lavfi sources, macOS `say`,
// and seeded math, so two runs produce byte-identical files. Ground truth lives in
// fixtures/ground-truth.json (committed); media lives in fixtures/media (gitignored).
//
//   node scripts/fixtures/make-fixtures.mjs            generate missing fixtures
//   node scripts/fixtures/make-fixtures.mjs --force    regenerate everything
//   node scripts/fixtures/make-fixtures.mjs --update   regenerate and rewrite checksums in ground truth
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = process.env.DIRECTOR_FIXTURES_OUT ?? join(root, 'fixtures', 'media');
const gtPath = join(root, 'fixtures', 'ground-truth.json');
const force = process.argv.includes('--force');
const update = process.argv.includes('--update');
mkdirSync(outDir, { recursive: true });

const BITEXACT = ['-fflags', '+bitexact', '-flags:v', '+bitexact', '-flags:a', '+bitexact', '-map_metadata', '-1'];
const X264 = ['-c:v', 'libx264', '-threads', '1', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-bf', '0', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];

function ff(args) {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ffmpeg failed: ${res.stderr}`);
}

/** 12-bit frame-number barcode in the top-left: bit k lit when (n >> k) & 1. 40px cells. */
function barcode(bits = 12, cell = 40) {
  const parts = [`drawbox=x=0:y=0:w=${bits * cell + 8}:h=${cell + 8}:color=black:t=fill`];
  for (let k = 0; k < bits; k++) parts.push(`drawbox=x=${4 + k * cell}:y=4:w=${cell - 4}:h=${cell}:color=white:t=fill:enable='eq(mod(floor(n/${2 ** k})\\,2)\\,1)'`);
  return parts.join(',');
}

// --- deterministic PCM helpers -------------------------------------------------------------
function wavHeader(samples, rate, channels) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2 * channels, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28); b.writeUInt16LE(2 * channels, 32); b.writeUInt16LE(16, 34); b.write('data', 36);
  b.writeUInt32LE(samples * 2 * channels, 40);
  return b;
}
function writeWav(path, floats, rate = 48000) {
  const pcm = Buffer.alloc(floats.length * 2);
  for (let i = 0; i < floats.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(floats[i] * 32767))), i * 2);
  writeFileSync(path, Buffer.concat([wavHeader(floats.length, rate, 1), pcm]));
}
function readPcm(path) {
  // Decode any audio file to 48 kHz mono float via ffmpeg.
  const res = spawnSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`decode failed ${path}`);
  const buf = res.stdout;
  const out = new Float32Array(buf.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}
function mulberry32(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Trim leading/trailing near-silence so word boundaries are tight. */
function trimSilence(x, thr = 0.01) {
  let a = 0; while (a < x.length && Math.abs(x[a]) < thr) a++;
  let b = x.length - 1; while (b > a && Math.abs(x[b]) < thr) b--;
  return x.subarray(Math.max(0, a - 48), Math.min(x.length, b + 48));
}
const sayCache = new Map();
function sayWord(word, voice = 'Samantha') {
  const key = `${voice}:${word}`;
  if (sayCache.has(key)) return sayCache.get(key);
  const t = join(tmpdir(), `director-say-${createHash('sha1').update(key).digest('hex')}.aiff`);
  const res = spawnSync('say', ['-v', voice, '-r', '190', '-o', t, word]);
  if (res.status !== 0) throw new Error(`say failed for ${word}`);
  const pcm = trimSilence(readPcm(t));
  rmSync(t, { force: true });
  sayCache.set(key, pcm);
  return pcm;
}

/**
 * Build speech from a list of tokens. A token is a word, or {pause: seconds}.
 * Returns samples plus exact word timings (seconds) for ground truth.
 */
function speech(tokens, { gap = 0.09, rate = 48000, lead = 0.5, tail = 0.5 } = {}) {
  const chunks = [];
  const words = [];
  let pos = Math.round(lead * rate);
  chunks.push(new Float32Array(pos));
  for (const tok of tokens) {
    if (typeof tok === 'object') { const n = Math.round(tok.pause * rate); chunks.push(new Float32Array(n)); pos += n; continue; }
    const pcm = sayWord(tok);
    words.push({ text: tok, start: +(pos / rate).toFixed(4), end: +((pos + pcm.length) / rate).toFixed(4) });
    chunks.push(pcm); pos += pcm.length;
    const g = Math.round(gap * rate); chunks.push(new Float32Array(g)); pos += g;
  }
  const t = Math.round(tail * rate); chunks.push(new Float32Array(t)); pos += t;
  const out = new Float32Array(pos);
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return { samples: out, words, duration: pos / rate };
}
const words = (s) => s.split(/\s+/).filter(Boolean);

// --- fixture specs -----------------------------------------------------------------------------
const SCRIPT_LINES = [
  'Stop typing plain prompts into Claude',
  'Ask me questions before you answer',
  'Give me three options and pick the best one',
  'Write this for a busy owner who reads on their phone',
  'Critique your answer like a tough editor',
  'Save this before your next prompt',
];

const specs = {
  'sync-1080p30.mp4': {
    truth: { width: 1920, height: 1080, fps: [30, 1], frames: 300, durationSec: 10, flashEveryFrames: 30, beepEverySec: 1, beepHz: 1000, barcodeBits: 12, barcodeCell: 40 },
    make(out) {
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=10', '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t\\,1)\\,1/30)\\,0.8*sin(2*PI*1000*t)\\,0)':s=48000:d=10",
        '-vf', `drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(mod(n\\,30)\\,0)',${barcode()}`,
        ...X264, '-c:a', 'aac', '-b:a', '128k', '-ac', '1', '-shortest', ...BITEXACT, out]);
    },
  },
  'vertical-1080x1920.mp4': {
    truth: { width: 1080, height: 1920, fps: [30, 1], frames: 150, durationSec: 5 },
    make(out) {
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=5', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=5', '-vf', barcode(), ...X264, '-c:a', 'aac', '-b:a', '128k', '-ac', '1', '-shortest', ...BITEXACT, out]);
    },
  },
  'hevc-4k.mp4': {
    truth: { width: 3840, height: 2160, fps: [30, 1], frames: 90, durationSec: 3, codec: 'hevc' },
    make(out) {
      ff(['-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=3', '-vf', barcode(12, 80), '-c:v', 'libx265', '-x265-params', 'pools=none:frame-threads=1:log-level=error', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', ...BITEXACT, out]);
    },
  },
  'still.png': {
    truth: { width: 1080, height: 1080, kind: 'image' },
    make(out) { ff(['-f', 'lavfi', '-i', 'testsrc2=s=1080x1080:r=1:d=1', '-frames:v', '1', ...BITEXACT, out]); },
  },
  'tone-440.wav': {
    truth: { sampleRate: 48000, channels: 1, durationSec: 4, hz: 440, amplitude: 0.5 },
    make(out) {
      const n = 48000 * 4; const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000);
      writeWav(out, x);
    },
  },
  'speech.wav': {
    truthFrom: 'speech',
    make(out, gt) {
      const toks = [];
      SCRIPT_LINES.forEach((line, i) => { toks.push(...words(line)); if (i < SCRIPT_LINES.length - 1) toks.push({ pause: i % 2 === 0 ? 1.2 : 0.7 }); });
      const s = speech(toks);
      writeWav(out, s.samples);
      gt.speech = { file: 'speech.wav', durationSec: +s.duration.toFixed(4), words: s.words, lines: SCRIPT_LINES };
    },
  },
  'speech-gaps.wav': {
    truthFrom: 'speechGaps',
    make(out, gt) {
      // Known pauses (seconds) between phrases, including fillers to detect.
      const toks = [...words('So here is the thing'), { pause: 1.0 }, 'um', ...words('most people never ask'), { pause: 0.25 }, ...words('the right question'), { pause: 1.6 }, 'uh', ...words('and that costs them'), { pause: 0.6 }, ...words('every single day')];
      const s = speech(toks, { lead: 0.8, tail: 0.8 });
      writeWav(out, s.samples);
      gt.speechGaps = { file: 'speech-gaps.wav', durationSec: +s.duration.toFixed(4), words: s.words, fillers: ['um', 'uh'] };
    },
  },
  'retakes.wav': {
    truthFrom: 'retakes',
    make(out, gt) {
      // Read the script with retakes on lines 2 and 5 (1-based), a false start, and one ad-lib.
      const toks = []; const takes = [];
      const say = (line, kind) => { toks.push({ mark: kind, line }); toks.push(...words(line)); toks.push({ pause: 0.6 }); };
      say(SCRIPT_LINES[0], 'keep');
      say('Ask me questions before you', 'bad'); // false start, line 2
      say(SCRIPT_LINES[1], 'keep');
      say(SCRIPT_LINES[2], 'keep');
      say('Honestly this one changed everything for me', 'adlib');
      say(SCRIPT_LINES[3], 'keep');
      say(SCRIPT_LINES[4], 'bad'); // complete but flagged as retake by re-reading
      say(SCRIPT_LINES[4], 'keep');
      say(SCRIPT_LINES[5], 'keep');
      const flat = toks.filter((t) => !(t && t.mark));
      const s = speech(flat, { lead: 0.6, tail: 0.6 });
      // Recover segment intervals from word timings.
      let wi = 0;
      for (const t of toks) {
        if (t && t.mark) {
          const n = words(t.line).length;
          const ws = s.words.slice(wi, wi + n);
          takes.push({ kind: t.mark, text: t.line, start: ws[0].start, end: ws[n - 1].end });
          wi += n;
        }
      }
      writeWav(out, s.samples);
      gt.retakes = { file: 'retakes.wav', durationSec: +s.duration.toFixed(4), takes, words: s.words, lines: SCRIPT_LINES };
    },
  },
  'noisy-speech.wav': {
    truthFrom: 'noisy',
    make(out, gt) {
      const s = speech(words(SCRIPT_LINES[0] + ' ' + SCRIPT_LINES[1]));
      const rnd = mulberry32(42);
      const noise = 0.05;
      const x = new Float32Array(s.samples.length);
      for (let i = 0; i < x.length; i++) x[i] = s.samples[i] + noise * (rnd() * 2 - 1);
      writeWav(out, x);
      writeWav(join(outDir, 'clean-speech.wav'), s.samples);
      gt.noisy = { file: 'noisy-speech.wav', clean: 'clean-speech.wav', noiseAmplitude: noise, seed: 42 };
    },
  },
  'follow-hold.wav': {
    truthFrom: 'followHold',
    make(out, gt) {
      // Line 1, five seconds of silence, an ad-lib that is not in the script, then line 2.
      const adlib = 'Honestly this one changed everything for me';
      const s = speech([...words(SCRIPT_LINES[0]), { pause: 5 }, ...words(adlib), { pause: 0.8 }, ...words(SCRIPT_LINES[1])], { lead: 0.6, tail: 0.8 });
      writeWav(out, s.samples);
      const n0 = words(SCRIPT_LINES[0]).length; const na = words(adlib).length;
      gt.followHold = { file: 'follow-hold.wav', durationSec: +s.duration.toFixed(4), words: s.words, line1End: s.words[n0 - 1].end, adlibStart: s.words[n0].start, adlibEnd: s.words[n0 + na - 1].end, line2Start: s.words[n0 + na].start, lines: SCRIPT_LINES };
    },
  },
  'click-120bpm.wav': {
    truth: { bpm: 120, durationSec: 10, firstBeatSec: 0.5 },
    make(out) {
      const rate = 48000; const n = rate * 10; const x = new Float32Array(n);
      for (let b = 0.5; b < 10; b += 0.5) { const s = Math.round(b * rate); for (let i = 0; i < 480 && s + i < n; i++) x[s + i] = 0.9 * Math.sin((2 * Math.PI * 2000 * i) / rate) * (1 - i / 480); }
      writeWav(out, x);
    },
  },
  'cuts-720p.mp4': {
    truth: { width: 1280, height: 720, fps: [30, 1], cutsAtFrames: [45, 96, 120, 171, 240, 264], frames: 300 },
    make(out) {
      // Seven visually distinct shots separated by hard cuts at known frames.
      const cuts = [0, 45, 96, 120, 171, 240, 264, 300];
      const sources = ['testsrc2', 'smptebars', 'rgbtestsrc', 'mandelbrot', 'testsrc', 'pal75bars', 'yuvtestsrc'];
      const inputs = []; const labels = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        const frames = cuts[i + 1] - cuts[i];
        inputs.push('-f', 'lavfi', '-i', `${sources[i]}=s=1280x720:r=30,trim=end_frame=${frames},setpts=PTS-STARTPTS`);
        labels.push(`[${i}:v]`);
      }
      ff([...inputs, '-filter_complex', `${labels.join('')}concat=n=${labels.length}:v=1:a=0,format=yuv420p[v]`, '-map', '[v]', ...X264, ...BITEXACT, out]);
    },
  },
  'reference-reel.mp4': {
    // A vertical "reference reel": the speech fixture over eight distinct shots with hard cuts at
    // known frames (a fast cut inside the hook, then roughly one per line). Used by the Swipe analyzer.
    truth: { width: 720, height: 1280, fps: [30, 1], cutsAtFrames: [60, 135, 245, 300, 395, 555, 690], frames: 804, audio: 'speech.wav' },
    make(out) {
      const speech = join(outDir, 'speech.wav');
      if (!existsSync(speech)) specs['speech.wav'].make(speech, {});
      const cuts = [0, 60, 135, 245, 300, 395, 555, 690, 805];
      const sources = ['testsrc2', 'smptebars', 'rgbtestsrc', 'mandelbrot', 'testsrc', 'pal75bars', 'yuvtestsrc', 'smptehdbars'];
      const inputs = []; const labels = [];
      for (let i = 0; i < cuts.length - 1; i++) {
        inputs.push('-f', 'lavfi', '-i', `${sources[i]}=s=720x1280:r=30,trim=end_frame=${cuts[i + 1] - cuts[i]},setpts=PTS-STARTPTS`);
        labels.push(`[${i}:v]`);
      }
      inputs.push('-i', speech);
      ff([...inputs, '-filter_complex', `${labels.join('')}concat=n=${labels.length}:v=1:a=0,format=yuv420p[v]`, '-map', '[v]', '-map', `${labels.length}:a`, ...X264, '-c:a', 'aac', '-b:a', '128k', '-shortest', ...BITEXACT, out]);
    },
  },
};

// --- run --------------------------------------------------------------------------------------
const gt = existsSync(gtPath) ? JSON.parse(readFileSync(gtPath, 'utf8')) : { checksums: {}, files: {} };
gt.checksums ??= {}; gt.files ??= {};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
let made = 0;
for (const [name, spec] of Object.entries(specs)) {
  const out = join(outDir, name);
  if (!force && existsSync(out)) continue;
  const scratch = {};
  spec.make(out, scratch);
  made++;
  if (update) {
    if (spec.truth) gt.files[name] = spec.truth;
    Object.assign(gt, scratch);
  }
}
if (update) {
  gt.checksums = {};
  for (const name of [...Object.keys(specs), 'clean-speech.wav']) if (existsSync(join(outDir, name))) gt.checksums[name] = sha(join(outDir, name));
  gt.generatedWith = { ffmpeg: spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).stdout.split('\n')[0] };
  writeFileSync(gtPath, JSON.stringify(gt, null, 2) + '\n');
}
const sums = {};
for (const name of Object.keys(gt.checksums)) if (existsSync(join(outDir, name))) sums[name] = sha(join(outDir, name));
console.log(JSON.stringify({ outDir, made, checksums: sums }));
