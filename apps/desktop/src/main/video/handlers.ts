import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { runJobOk, ffmpegProgress } from '../jobs/runner';
import { requireSidecar } from '../jobs/sidecars';
import { probeMedia } from '../jobs/probe';
import { quickHash, cacheDirFor } from '../media/importer';
import { mediaCacheRoot } from '../media/handlers';

export const videoHandlers = {
  /** Face boxes over time (Apple Vision), for auto reframe. */
  'video:faces': async (i: { path: string; every?: number; projectDir?: string }) => {
    const dir = cacheDirFor(mediaCacheRoot(i.projectDir), quickHash(i.path));
    const cache = join(dir, `faces-${i.every ?? 3}.json`);
    if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
    const res = await runJobOk({ kind: 'faces', cmd: requireSidecar('director-native'), args: ['faces', '--file', i.path, '--every', String(i.every ?? 3)] });
    const track = res.stdout.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => typeof o.t === 'number');
    (await import('node:fs')).writeFileSync(cache, JSON.stringify(track));
    return track as Array<{ t: number; faces: Array<{ x: number; y: number; w: number; h: number; c: number }> }>;
  },
  /**
   * Who is on screen and how their lips move (Apple Vision landmarks), plus the picture area inside any letterbox bars,
   * for speaker detection. Cached per file.
   */
  'video:speakers': async (i: { path: string; projectDir?: string }) => {
    const dir = cacheDirFor(mediaCacheRoot(i.projectDir), quickHash(i.path));
    const cache = join(dir, 'speakers-3.json');
    if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
    const p = await probeMedia(i.path);
    const ff = requireSidecar('ffmpeg');
    // Letterbox: the most common crop over keyframes across the whole file.
    const crop = await runJobOk({ kind: 'cropdetect', cmd: ff, args: ['-hide_banner', '-skip_frame', 'nokey', '-i', i.path, '-an', '-vf', 'cropdetect=limit=24:round=2:reset=1', '-f', 'null', '-'] });
    const counts = new Map<string, number>();
    for (const m of crop.stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0].match(/(\d+):(\d+):(\d+):(\d+)/);
    const W = p.video?.width ?? 1920, H = p.video?.height ?? 1080;
    let content = { x: 0, y: 0, w: 1, h: 1 };
    if (best) {
      const [cw = 0, ch = 0, cx = 0, cy = 0] = best.slice(1).map(Number);
      // Only trust a clear letterbox or pillarbox (bars at least 2% of the frame).
      if (cw * ch < W * H * 0.96 && cw > W * 0.3 && ch > H * 0.3) content = { x: cx / W, y: cy / H, w: cw / W, h: ch / H };
    }
    const res = await runJobOk({
      kind: 'speakers', cmd: requireSidecar('director-native'), args: ['faces', '--file', i.path, '--every', '3', '--mouth'],
      total: p.durationUs, parseProgress: (l) => { const m = l.match(/"t":([\d.]+)/); return m ? Number(m[1]) * 1e6 : null; },
    });
    const samples = res.stdout.trim().split('\n').map((l) => JSON.parse(l)).filter((o) => typeof o.t === 'number');
    const out = { content, samples };
    (await import('node:fs')).writeFileSync(cache, JSON.stringify(out));
    return out;
  },
  /** Person matte video (Apple Vision segmentation) for background removal. */
  'video:segment': async (i: { path: string; quality?: 'fast' | 'balanced' | 'accurate'; projectDir?: string }) => {
    const dir = cacheDirFor(mediaCacheRoot(i.projectDir), quickHash(i.path));
    const out = join(dir, `matte-${i.quality ?? 'balanced'}.mov`);
    if (!existsSync(out)) {
      const tmp = `${out}.tmp.mov`;
      await runJobOk({ kind: 'segment', cmd: requireSidecar('director-native'), args: ['segment', '--file', i.path, '--out', tmp, '--quality', i.quality ?? 'balanced'] });
      renameSync(tmp, out);
    }
    return out;
  },
  /** Two-pass vidstab stabilization into a new file. */
  'video:stabilize': async (i: { path: string; smoothing?: number; projectDir?: string }) => {
    const dir = cacheDirFor(mediaCacheRoot(i.projectDir), quickHash(i.path));
    const out = join(dir, `stabilized-${i.smoothing ?? 15}.mp4`);
    if (existsSync(out)) return { path: out, probe: await probeMedia(out) };
    const trf = join(dir, 'transforms.trf');
    const p = await probeMedia(i.path);
    const ff = requireSidecar('ffmpeg');
    await runJobOk({ kind: 'stabilize-detect', cmd: ff, total: p.durationUs, parseProgress: ffmpegProgress, args: ['-v', 'error', '-y', '-progress', 'pipe:1', '-i', i.path, '-vf', `vidstabdetect=shakiness=8:accuracy=15:result=${trf}`, '-f', 'null', '-'] });
    const tmp = `${out}.tmp.mp4`;
    await runJobOk({ kind: 'stabilize', cmd: ff, total: p.durationUs, parseProgress: ffmpegProgress, args: ['-v', 'error', '-y', '-progress', 'pipe:1', '-i', i.path, '-vf', `vidstabtransform=input=${trf}:smoothing=${i.smoothing ?? 15}:zoom=3:optzoom=0,unsharp=5:5:0.6:3:3:0.4`, '-c:v', 'h264_videotoolbox', '-b:v', '20M', '-c:a', 'copy', tmp] });
    renameSync(tmp, out);
    return { path: out, probe: await probeMedia(out) };
  },
};
