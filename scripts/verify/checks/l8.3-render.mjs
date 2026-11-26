import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { assert, fixture, tmp } from '../lib.mjs';
import { agentSession, must } from '../agent-lib.mjs';

/** Decode a PNG to RGB with ffmpeg; returns a pixel reader. */
function decode(b64, dir, name) {
  const png = Buffer.from(b64, 'base64');
  const p = join(dir, `${name}.png`);
  writeFileSync(p, png);
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 256 << 20 }).stdout;
  assert(raw.length === w * h * 3, `decoded ${raw.length} bytes for ${w}x${h}`);
  return { w, h, px: (x, y) => { const i = (Math.round(y) * w + Math.round(x)) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; } };
}

/** The 12-bit frame barcode of the sync fixture, drawn at (ox, oy) with scale s. */
function barcode(img, ox, oy, s) {
  let n = 0;
  for (let k = 0; k < 12; k++) if (img.px(ox + (4 + k * 40 + 18) * s, oy + 24 * s)[0] > 128) n |= 1 << k;
  return n;
}

export default async function () {
  const s = await agentSession({ mode: 'auto', project: false });
  const { client } = s;
  const dir = tmp('l8.3-render');
  try {
    await must(client, 'create_project', { name: 'Render check', preset: 'landscape-1080' });
    const m = (await must(client, 'import_media', { paths: [fixture('sync-1080p30.mp4')] })).added[0];
    const clip = (await must(client, 'add_clip', { media: m.id, lane: 'camera', start: 0 })).result.clip;
    // Full-size frames show exactly the requested frame.
    const frames = [0, 37, 150, 299];
    for (const f of frames) {
      const r = await must(client, 'render_frame', { t: (f + 0.5) / 30, width: 1920 });
      const img = decode(r.image.data, dir, `f${f}`);
      assert(img.w === 1920 && img.h === 1080 && r.width === 1920, `size ${img.w}x${img.h}`);
      assert(barcode(img, 0, 0, 1) === f, `frame at ${(f + 0.5) / 30} s shows ${barcode(img, 0, 0, 1)}, want ${f}`);
    }
    // Default size is 540 wide and keeps the project's shape.
    const small = await must(client, 'render_frame', { t: 1 });
    const si = decode(small.image.data, dir, 'small');
    assert(si.w === 540 && si.h === 304 && barcode(si, 0, 0, 540 / 1920) === 30, `540 frame ${si.w}x${si.h} barcode ${barcode(si, 0, 0, 540 / 1920)}`);
    // A contact sheet: a grid, each cell the frame at its listed time.
    const sheet = await must(client, 'render_contact_sheet', { from: 0, to: 9.9, count: 6, columns: 3, width: 1800 });
    const sh2 = decode(sheet.image.data, dir, 'sheet');
    const cw = 600, ch = 338;
    assert(sh2.w === cw * 3 && sh2.h === ch * 2 && sheet.times.length === 6, `sheet ${sh2.w}x${sh2.h}`);
    const got = sheet.times.map((t, i) => barcode(sh2, (i % 3) * cw, Math.floor(i / 3) * ch, cw / 1920));
    const want = sheet.times.map((t) => Math.floor(t * 30 + 1e-6));
    assert(got.every((g, i) => Math.abs(g - want[i]) <= 1), `sheet frames ${got} want ${want}`);
    // The render shows edits: black and white grade turns the colour bars grey.
    const before = decode((await must(client, 'render_frame', { t: 2.5, width: 960 })).image.data, dir, 'color');
    let colored = 0;
    for (let y = 200; y < 500; y += 20) for (let x = 100; x < 900; x += 40) { const [r, g, b] = before.px(x, y); if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colored++; }
    await must(client, 'add_effect', { clips: [clip], type: 'color', params: { saturation: -1 } });
    const after = decode((await must(client, 'render_frame', { t: 2.5, width: 960 })).image.data, dir, 'grey');
    let grey = 0, total = 0;
    for (let y = 200; y < 500; y += 20) for (let x = 100; x < 900; x += 40) { const [r, g, b] = after.px(x, y); total++; if (Math.max(r, g, b) - Math.min(r, g, b) <= 12) grey++; }
    assert(colored > 20 && grey === total, `colour samples before ${colored}, grey after ${grey}/${total}`);
    return `render_frame showed frames ${frames.join(', ')} exactly at 1920x1080 and frame 30 at the default 540x304; a 3x2 contact sheet (1800x676) showed frames ${got.join(', ')} for times ${sheet.times.join(', ')}; after add_effect saturation -1, ${grey}/${total} samples that were colour (${colored}) render grey`;
  } finally { await s.close(); }
}
