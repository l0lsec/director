import { assert, tmp, sh, fixture } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Mean absolute frame-to-frame translation (pixels at 320x180), by brute-force block matching. */
function motion(file) {
  const W = 320, H = 180;
  // Binary-safe: raw frames must not go through a text decoder.
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 29 });
  const n = Math.floor(buf.length / (W * H));
  const R = 10, x0 = 40, y0 = 30, x1 = W - 40, y1 = H - 30;
  let total = 0;
  for (let f = 1; f < n; f++) {
    const a = (f - 1) * W * H, b = f * W * H;
    let best = Infinity, bx = 0, by = 0;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      let sad = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) sad += Math.abs(buf[a + y * W + x] - buf[b + (y + dy) * W + x + dx]);
      if (sad < best) { best = sad; bx = dx; by = dy; }
    }
    total += Math.abs(bx) + Math.abs(by);
  }
  return total / Math.max(1, n - 1);
}

export default async function () {
  const dir = tmp('stab');
  const shaky = join(dir, 'shaky.mp4');
  // A still frame shaken by a deterministic jitter of up to about 30 px.
  sh('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', fixture('still.png'), '-t', '4', '-r', '30', '-vf', "scale=1400:1400,crop=1280:720:60+30*sin(n*1.7)+18*sin(n*0.43):340+28*cos(n*1.3)+15*sin(n*0.71),format=yuv420p", '-c:v', 'libx264', '-g', '30', shaky]);
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  let out;
  try {
    out = await win.evaluate(async (p) => (await window.director.invoke('video:stabilize', { path: p, smoothing: 30 })).value.path, shaky);
  } finally { await app.close(); }
  const before = motion(shaky);
  const after = motion(out);
  const detail = `residual motion ${before.toFixed(2)} -> ${after.toFixed(2)} px/frame (${((1 - after / before) * 100).toFixed(0)}% less)`;
  assert(before > 2, `positive control: the shaky input must measure real motion (${detail})`);
  assert(after <= before * 0.5, detail);
  return detail;
}
