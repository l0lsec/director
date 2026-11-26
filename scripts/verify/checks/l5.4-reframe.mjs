import { assert, root, sh, fixture } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';
import { join } from 'node:path';

// Strict form: needs real talking-head footage with a moving face (no such fixture ships with the repo).
export default async function () {
  const footage = process.env.DIRECTOR_FACE_FOOTAGE;
  assert(footage, 'set DIRECTOR_FACE_FOOTAGE to a 16:9 clip of a person moving across the frame');
  const out = sh(join(root, 'native/DirectorKit/.build/release/director-native'), ['faces', '--file', footage, '--every', '2']).stdout.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.t != null);
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    const share = await win.evaluate(({ track }) => {
      const E = globalThis.__directorEngine;
      const clip = E.newClip({ kind: 'media', start: 0, in: 0, out: Math.round(track[track.length - 1].t * 1e6) });
      const x = E.reframeKeyframes(track, clip, { width: 1920, height: 1080 }, { width: 1080, height: 1920 });
      const cover = 1920 / 1080; const scaled = 1920 * cover; let inside = 0, n = 0;
      for (const s of track) { const f = s.faces[0]; if (!f) continue; const cx = 540 + (f.x + f.w / 2 - 0.5) * scaled + E.evalAnim(x, s.t * 1e6); n++; if (cx > 360 && cx < 720) inside++; }
      return inside / Math.max(1, n);
    }, { track: out });
    assert(share >= 0.95, `face in the center third ${(share * 100).toFixed(1)}% of frames`);
    void fixture;
    return `face kept in the center third in ${(share * 100).toFixed(1)}% of frames`;
  } finally { await app.close(); }
}
