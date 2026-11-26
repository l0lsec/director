import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { MediaRef } from '@director/engine';
import { probeMedia, type ProbeResult } from '../jobs/probe';
import { runJobOk, ffmpegProgress } from '../jobs/runner';
import { requireSidecar } from '../jobs/sidecars';

export const MEDIA_EXTS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic']);

/** Fast content hash: size + first and last MiB. Stable across moves and renames. */
export function quickHash(path: string): string {
  const size = statSync(path).size;
  const h = createHash('sha1');
  h.update(String(size));
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(Math.min(1 << 20, size));
    readSync(fd, chunk, 0, chunk.length, 0);
    h.update(chunk);
    if (size > chunk.length) { readSync(fd, chunk, 0, chunk.length, Math.max(0, size - chunk.length)); h.update(chunk); }
  } finally { closeSync(fd); }
  return h.digest('hex');
}

export interface ImportedMedia { media: MediaRef; derived: { thumbs?: string; thumbCount?: number; peaks?: string; peaksRate?: number }; needsProxy: boolean; reason?: string }

export function cacheDirFor(root: string, hash: string): string {
  const d = join(root, hash.slice(0, 2), hash);
  mkdirSync(d, { recursive: true });
  return d;
}

/** Decide whether preview needs a proxy: above 1080p, codecs WebCodecs may not decode, or 10-bit/ProRes. */
export function proxyReason(p: ProbeResult): string | null {
  const v = p.video;
  if (!v || p.kind !== 'video') return null;
  if (v.width * v.height > 1920 * 1088) return `${v.width}x${v.height} is above 1080p`;
  if (!['h264', 'hevc', 'vp9', 'av1', 'vp8'].includes(v.codec)) return `${v.codec} is not decodable for preview`;
  if (v.pixFmt && /10|12|422|444/.test(v.pixFmt) && v.codec !== 'hevc') return `${v.pixFmt} pixel format`;
  return null;
}

export function toMediaRef(path: string, p: ProbeResult, hash: string, role?: MediaRef['role']): MediaRef {
  return {
    id: `media_${hash.slice(0, 10)}_${randomUUID().slice(0, 4)}`,
    path, hash, name: basename(path), kind: p.kind, durationUs: p.durationUs,
    width: p.video?.displayWidth, height: p.video?.displayHeight, fps: p.video?.fps.num ? p.video.fps : undefined,
    hasAudio: !!p.audio, hasVideo: !!p.video, sampleRate: p.audio?.sampleRate, channels: p.audio?.channels,
    codec: p.video?.codec ?? p.audio?.codec, rotation: p.video?.rotation, addedAt: new Date().toISOString(),
    role: role ?? (p.kind === 'image' ? 'image' : p.kind === 'audio' ? 'music' : 'broll'),
  };
}

/** Filmstrip: N frames scaled to 160px tall, tiled horizontally in one JPEG. */
export async function makeThumbs(path: string, p: ProbeResult, outDir: string, count = 12): Promise<{ file: string; count: number } | null> {
  if (!p.video) return null;
  const file = join(outDir, 'thumbs.jpg');
  if (existsSync(file)) return { file, count };
  if (p.kind === 'image') {
    await runJobOk({ kind: 'thumbs', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-i', path, '-vf', 'scale=-2:160', '-frames:v', '1', file] });
    return { file, count: 1 };
  }
  const dur = Math.max(0.1, p.durationUs / 1e6);
  const fps = count / dur;
  await runJobOk({ kind: 'thumbs', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-skip_frame', 'nokey', '-i', path, '-vf', `fps=${fps.toFixed(6)},scale=-2:160,tile=${count}x1`, '-frames:v', '1', '-q:v', '5', file] }).catch(async () => {
    await runJobOk({ kind: 'thumbs', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-i', path, '-vf', `fps=${fps.toFixed(6)},scale=-2:160,tile=${count}x1`, '-frames:v', '1', '-q:v', '5', file] });
  });
  return { file, count };
}

/** Waveform peaks: sqrt-scaled max amplitude per 10 ms window as bytes (100 values per second). */
export async function makePeaksBinary(path: string, p: ProbeResult, outDir: string): Promise<{ file: string; rate: number } | null> {
  if (!p.audio) return null;
  const file = join(outDir, 'peaks.u8');
  if (existsSync(file)) return { file, rate: 100 };
  const pcmFile = join(outDir, 'peaks.tmp.s16');
  await runJobOk({ kind: 'peaks', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', pcmFile] });
  const pcm = readFileSync(pcmFile);
  const win = 80; // 10 ms at 8 kHz
  const n = Math.ceil(pcm.length / 2 / win);
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let j = i * win; j < Math.min((i + 1) * win, pcm.length / 2); j++) m = Math.max(m, Math.abs(pcm.readInt16LE(j * 2)));
    out[i] = Math.min(255, Math.round(Math.sqrt(m / 32768) * 255));
  }
  writeFileSync(file, out);
  try { (await import('node:fs')).rmSync(pcmFile); } catch { /* ignore */ }
  return { file, rate: 100 };
}

/** 1080p short-GOP H.264 proxy with hardware encoding (fast seeking for preview). */
export async function makeProxy(path: string, p: ProbeResult, outDir: string): Promise<string> {
  const file = join(outDir, 'proxy.mp4');
  if (existsSync(file)) return file;
  const v = p.video!;
  const vertical = v.displayHeight > v.displayWidth;
  const scale = vertical ? 'scale=1080:-2' : 'scale=-2:1080';
  const tmp = join(outDir, 'proxy.tmp.mp4');
  await runJobOk({
    kind: 'proxy', cmd: requireSidecar('ffmpeg'), total: p.durationUs, parseProgress: ffmpegProgress,
    args: ['-v', 'error', '-y', '-progress', 'pipe:1', '-i', path, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `${scale},format=yuv420p`, '-c:v', 'h264_videotoolbox', '-b:v', '10M', '-g', '15', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp],
  });
  (await import('node:fs')).renameSync(tmp, file);
  return file;
}

export async function importOne(path: string, cacheRoot: string, opts: { proxies?: boolean; role?: MediaRef['role'] } = {}): Promise<ImportedMedia> {
  const p = await probeMedia(path);
  const hash = quickHash(path);
  const dir = cacheDirFor(cacheRoot, hash);
  const media = toMediaRef(path, p, hash, opts.role);
  const [thumbs, peaks] = await Promise.all([makeThumbs(path, p, dir).catch(() => null), makePeaksBinary(path, p, dir).catch(() => null)]);
  const reason = proxyReason(p);
  if (reason && opts.proxies !== false) media.proxyPath = await makeProxy(path, p, dir);
  return { media, derived: { thumbs: thumbs?.file, thumbCount: thumbs?.count, peaks: peaks?.file, peaksRate: peaks?.rate }, needsProxy: !!reason, reason: reason ?? undefined };
}

export function expandPaths(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string, depth: number) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { if (depth < 4) for (const e of readdirSync(p)) if (!e.startsWith('.')) walk(join(p, e), depth + 1); }
    else if (MEDIA_EXTS.has(extname(p).toLowerCase())) out.push(p);
  };
  for (const p of paths) walk(p, 0);
  return out;
}

/** Find a moved file by content hash under the given folders. */
export function findByHash(hash: string, size: number | null, dirs: string[], maxFiles = 20000): string | null {
  let seen = 0;
  const stack = [...dirs];
  while (stack.length && seen < maxFiles) {
    const d = stack.pop()!;
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { continue; }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { stack.push(p); continue; }
      if (!MEDIA_EXTS.has(extname(p).toLowerCase())) continue;
      seen++;
      if (size != null && st.size !== size) continue;
      try { if (quickHash(p) === hash) return p; } catch { /* unreadable */ }
    }
  }
  return null;
}
