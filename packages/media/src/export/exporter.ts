import { Output, Mp4OutputFormat, StreamTarget, CanvasSource, AudioSampleSource, AudioSample, canEncodeVideo } from 'mediabunny';
import { frameToMicros, timelineDuration, type Fps, type Project } from '@director/engine';
import { Compositor } from '../compositor/gl';
import { MediaPool, FrameReader } from '../decode/pool';
import { TextRenderer } from '../text/render';
import { renderFrame, loadLuts, type FrameSource } from '../render';
import type { VisualPlan } from '../timeline/plan';
import { mediaUrl } from '../url';

export interface ExportSpec {
  width: number;
  height: number;
  fps: Fps;
  codec: 'avc' | 'hevc';
  videoBitrate: number;
  audioBitrate: number;
  fromUs?: number;
  toUs?: number;
}

export interface MixedAudio { channels: Float32Array[]; sampleRate: number }

export interface ExportIO {
  write: (position: number, data: Uint8Array) => Promise<void>;
  progress: (ratio: number, frame: number, frames: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult { frames: number; seconds: number; codec: string; width: number; height: number }

async function bitmap(path: string, cache: Map<string, ImageBitmap>): Promise<ImageBitmap | null> {
  const hit = cache.get(path);
  if (hit) return hit;
  try {
    const b = await createImageBitmap(await (await fetch(mediaUrl(path))).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    cache.set(path, b);
    return b;
  } catch { return null; }
}

/** Render a project to an MP4 through the shared compositor. Works in a worker or on the main thread. */
export async function exportProject(doc: Project, spec: ExportSpec, audio: MixedAudio | null, io: ExportIO): Promise<ExportResult> {
  const codec = spec.codec === 'hevc' && (await canEncodeVideo('hevc', { width: spec.width, height: spec.height })) ? 'hevc' : 'avc';
  const scale = spec.width / doc.canvas.width;
  const W = Math.round(doc.canvas.width * scale / 2) * 2;
  const H = Math.round(doc.canvas.height * scale / 2) * 2;
  const canvas = new OffscreenCanvas(W, H);
  const comp = new Compositor(canvas);
  comp.resize(W, H);
  await loadLuts(doc, comp);
  const pool = new MediaPool(8);
  const text = new TextRenderer();
  const images = new Map<string, ImageBitmap>();
  const readers = new Map<string, FrameReader>();
  const fpsV = spec.fps.num / spec.fps.den;
  const from = spec.fromUs ?? 0;
  const to = spec.toUs ?? timelineDuration(doc);
  const frames = Math.max(1, Math.ceil(((to - from) / 1e6) * fpsV - 1e-6));

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new StreamTarget(new WritableStream({ write: (chunk) => io.write(chunk.position, chunk.data) }), { chunked: true, chunkSize: 4 * 1024 * 1024 }),
  });
  const video = new CanvasSource(canvas, { codec, bitrate: spec.videoBitrate, keyFrameInterval: 2, hardwareAcceleration: 'prefer-hardware', latencyMode: 'quality' });
  output.addVideoTrack(video, { frameRate: fpsV });
  const audioSource = audio ? new AudioSampleSource({ codec: 'aac', bitrate: spec.audioBitrate }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  let audioSent = 0; // samples
  const sendAudioUntil = async (sec: number) => {
    if (!audio || !audioSource) return;
    const total = audio.channels[0]!.length;
    const until = Math.min(total, Math.round(sec * audio.sampleRate));
    while (audioSent < until) {
      const n = Math.min(audio.sampleRate, until - audioSent);
      const planar = new Float32Array(n * audio.channels.length);
      audio.channels.forEach((ch, k) => planar.set(ch.subarray(audioSent, audioSent + n), k * n));
      const s = new AudioSample({ data: planar, format: 'f32-planar', numberOfChannels: audio.channels.length, sampleRate: audio.sampleRate, timestamp: audioSent / audio.sampleRate });
      await audioSource.add(s);
      s.close();
      audioSent += n;
    }
  };

  try {
    for (let i = 0; i < frames; i++) {
      if (io.signal?.aborted) throw Object.assign(new Error('Export cancelled'), { name: 'AbortError' });
      const t = from + frameToMicros(i, spec.fps);
      const { planFrame } = await import('../timeline/plan');
      const { withMattes } = await import('../timeline/plan');
      const plans = withMattes(planFrame(doc, t));
      const ready = new Map<string, FrameSource>();
      const toClose: VideoFrame[] = [];
      const live = new Set<string>();
      for (const p of plans) {
        if (p.kind === 'image' && p.path) { const b = await bitmap(p.path, images); if (b) ready.set(p.clip.id, { source: b, width: b.width, height: b.height }); continue; }
        if (p.kind !== 'video' || !p.path) continue;
        const original = p.clip.id.endsWith('#matte') ? p.path : doc.media[p.clip.mediaId!]!.path; // export uses originals, never proxies
        live.add(p.clip.id);
        if (p.clip.reverse) {
          const f = await pool.frameAt(original, p.srcSec ?? 0);
          if (f) { toClose.push(f.frame); ready.set(p.clip.id, { source: f.frame, width: f.width, height: f.height }); }
          continue;
        }
        let r = readers.get(p.clip.id);
        if (!r) { r = await pool.reader(original, p.srcSec ?? 0); readers.set(p.clip.id, r); }
        const sample = await r.frameAtExact(p.srcSec ?? 0);
        if (sample) { const vf = sample.toVideoFrame(); toClose.push(vf); ready.set(p.clip.id, { source: vf, width: sample.displayWidth, height: sample.displayHeight }); }
      }
      for (const [id, r] of readers) if (!live.has(id)) { r.dispose(); readers.delete(id); }
      renderFrame(comp, doc, t, (p: VisualPlan) => ready.get(p.clip.id) ?? null, text, scale);
      await video.add(i / fpsV, 1 / fpsV);
      for (const vf of toClose) vf.close();
      await sendAudioUntil((i + 1) / fpsV);
      if (i % 5 === 0 || i === frames - 1) io.progress((i + 1) / frames, i + 1, frames);
    }
    await sendAudioUntil(frames / fpsV + 1);
    video.close();
    audioSource?.close();
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => undefined);
    throw err;
  } finally {
    for (const r of readers.values()) r.dispose();
    pool.dispose();
    comp.dispose();
    for (const b of images.values()) b.close();
  }
  return { frames, seconds: frames / fpsV, codec, width: W, height: H };
}

export { EXPORT_PRESETS } from '@director/engine';
