import { assert, root, sh, fixture } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';
import { join } from 'node:path';

// Reframe logic on a synthetic face track (a face drifting and jittering across a 16:9 frame), plus the
// native face tracker running on a real video file.
export default async function () {
  const native = sh(join(root, 'native/DirectorKit/.build/release/director-native'), ['faces', '--file', fixture('cuts-720p.mp4'), '--every', '10']).stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert(native.some((o) => o.done) && native.filter((o) => o.t != null).length >= 25, 'native face tracker ran over the video');
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    const r = await win.evaluate(() => {
      const E = globalThis.__directorEngine;
      const track = [];
      let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
      for (let i = 0; i <= 300; i++) { const t = i / 30; const cx = 0.25 + 0.5 * (0.5 - 0.5 * Math.cos((t / 10) * Math.PI)) + (rnd() - 0.5) * 0.02; track.push({ t, faces: [{ x: cx - 0.06, y: 0.3, w: 0.12, h: 0.2 }] }); }
      const clip = E.newClip({ kind: 'media', start: 0, in: 0, out: 10_000_000 });
      const x = E.reframeKeyframes(track, clip, { width: 1920, height: 1080 }, { width: 1080, height: 1920 });
      const scaled = 1920 * (1920 / 1080);
      let inside = 0;
      for (const s of track) { const f = s.faces[0]; const cx = 540 + (f.x + f.w / 2 - 0.5) * scaled + E.evalAnim(x, Math.round(s.t * 1e6)); if (cx > 360 && cx < 720) inside++; }
      const maxShift = (scaled - 1080) / 2;
      return { share: inside / track.length, kfs: x.keyframes.length, inBounds: x.keyframes.every((k) => Math.abs(k.v) <= maxShift + 1) };
    });
    assert(r.inBounds, 'keyframes never expose the canvas edge');
    assert(r.share >= 0.95, `face in the center third ${(r.share * 100).toFixed(1)}%`);
    return `synthetic moving face kept in the center third in ${(r.share * 100).toFixed(1)}% of frames with ${r.kfs} keyframes; native tracker analysed ${native.filter((o) => o.t != null).length} frames`;
  } finally { await app.close(); }
}
