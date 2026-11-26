import { assert, tmp } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default async function () {
  const dir = tmp('thumbs');
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [sync] = await importFixtures(win, ['sync-1080p30.mp4']);
    await addToTimeline(win, sync, 0, 'camera');
    const files = {};
    for (const [w, h] of [[1080, 1920], [1280, 720]]) {
      const bytes = await win.evaluate(async ({ w, h }) => {
        const { lib } = globalThis.__directorMedia;
        const blob = await lib.renderThumbnail(globalThis.__directorProject().doc, 4_016_000, { width: w, height: h, title: 'Five prompt habits' });
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }, { w, h });
      files[`${w}x${h}`] = join(dir, `thumb-${w}x${h}.png`);
      writeFileSync(files[`${w}x${h}`], Buffer.from(bytes));
    }
    const dims = (p) => execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p]).toString().trim();
    assert(dims(files['1080x1920']) === '1080,1920' && dims(files['1280x720']) === '1280,720', 'image sizes');
    // 1280x720 from a 1920x1080 frame is an exact 2/3 scale: read the frame barcode (frame 120 at 4.016 s).
    const W = 1280, H = 720;
    const g = execFileSync('ffmpeg', ['-v', 'error', '-i', files['1280x720'], '-vf', 'format=gray', '-f', 'rawvideo', '-']);
    let n = 0;
    for (let k = 0; k < 12; k++) if (g[Math.round(24 * 2 / 3) * W + Math.round((4 + k * 40 + 18) * 2 / 3)] > 128) n |= 1 << k;
    assert(n === 120, `thumbnail frame ${n}, expected 120`);
    // Title: white text with a black outline across the middle band.
    let white = 0, black = 0;
    for (let y = Math.round(H * 0.42); y < Math.round(H * 0.58); y++) for (let x = 100; x < W - 100; x++) { const v = g[y * W + x]; if (v > 245) white++; else if (v < 10) black++; }
    assert(white > 3000 && black > 3000, `title not found (white ${white}, black ${black})`);
    return 'cover 1080x1920 and thumbnail 1280x720 written from frame 120 with the title';
  } finally { await app.close(); }
}
