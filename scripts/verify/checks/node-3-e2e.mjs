import { assert, tmp, sh } from '../lib.mjs';
import { execFileSync } from 'node:child_process';
import { launchEditor, importFixtures, addToTimeline, exportAndWait } from '../edit-lib.mjs';

const S = 1_000_000;

// The M2 golden edit (split, ripple trim, 2x) exported: frames carry the expected source frame numbers,
// the file passes ffprobe, and loudness lands on target.
export default async function () {
  const out = tmp('node3');
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [sync, speech] = await importFixtures(win, ['sync-1080p30.mp4', 'speech.wav']);
    await addToTimeline(win, sync, 0, 'camera');
    await addToTimeline(win, speech, 0, 'voice');
    await win.evaluate(() => {
      const d = globalThis.__directorProject().doc;
      const cam = d.lanes.find((l) => l.kind === 'camera').clips[0];
      globalThis.__directorEditCmd.setEdit({ selection: [cam.id], ripple: true });
      globalThis.__directorEditCmd.seek(3_000_000);
      globalThis.__directorEditCmd.splitAtPlayhead();
      const right = globalThis.__directorProject().doc.lanes.find((l) => l.kind === 'camera').clips[1];
      globalThis.__directorEditCmd.setEdit({ selection: [right.id] });
      globalThis.__directorEditCmd.seek(4_000_000);
      globalThis.__directorEditCmd.trimToPlayhead('start');
      globalThis.__directorEditCmd.setSpeed(2);
      // Keep the export to the camera's length.
      const v = globalThis.__directorProject().doc.lanes.find((l) => l.kind === 'voice').clips[0];
      globalThis.__directorProjectApply([{ op: 'updateClip', id: v.id, patch: { out: 6_000_000 } }], 'voice length');
    });
    const file = `${out}/golden.mp4`;
    const job = await exportAndWait(win, 'youtube-1080', file);
    assert(job.status === 'done', `export ${job.status}: ${job.error}`);
    // Read the barcode of chosen exported frames with ffmpeg.
    const expectFrame = (t) => (t < 3 * S ? Math.floor((t / S) * 30 + 1e-3) : Math.floor(((4 * S + (t - 3 * S) * 2) / S) * 30 + 1e-3));
    const misses = [];
    for (const frameIdx of [15, 45, 88, 91, 105, 128, 151, 177]) {
      const t = Math.round((frameIdx / 30) * S); // integer microseconds, as the engine computes frame times
      // Binary-safe read of the raw frame.
      const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${frameIdx}),crop=488:48:0:0,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-']);
      let n = 0;
      for (let k = 0; k < 12; k++) if (buf[24 * 488 + 4 + k * 40 + 18] > 128) n |= 1 << k;
      // Export samples each output frame at its start time.
      if (n !== expectFrame(Math.round(t))) misses.push(`frame ${frameIdx}: barcode ${n}, expected ${expectFrame(Math.round(t))}`);
    }
    assert(misses.length === 0, misses.join('\n'));
    const l = job.result.loudness;
    assert(l && Math.abs(l.integrated + 14) <= 1 && l.truePeak <= -1, `loudness ${JSON.stringify(l)}`);
    const v = JSON.parse(sh('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,color_primaries', '-of', 'json', file]).stdout).streams;
    assert(v.some((s) => s.codec_name === 'h264' && s.width === 1920 && s.color_primaries === 'bt709') && v.some((s) => s.codec_name === 'aac'), `streams ${JSON.stringify(v)}`);
    return `golden edit exported: 8/8 frames carry the expected source frame; ${l.integrated} LUFS, ${l.truePeak} dBTP`;
  } finally { await app.close(); }
}
