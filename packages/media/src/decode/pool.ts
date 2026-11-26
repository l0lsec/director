import { ALL_FORMATS, Input, UrlSource, VideoSampleSink, AudioBufferSink, type VideoSample, type InputVideoTrack, type InputAudioTrack } from 'mediabunny';
import { mediaUrl } from '../url';

/** Live VideoSample count, so tests can prove nothing leaks. */
export const frameStats = { open: 0, decoded: 0, readers: 0, liveReaders: new Set<FrameReader>() };

function track(s: VideoSample): VideoSample { frameStats.open++; frameStats.decoded++; return s; }
export function release(s: VideoSample | null | undefined): void { if (s) { s.close(); frameStats.open--; } }

export interface MediaHandle {
  key: string;
  path: string;
  input: Input;
  video: InputVideoTrack | null;
  audio: InputAudioTrack | null;
  sink: VideoSampleSink | null;
  width: number;
  height: number;
  rotation: number;
  durationSec: number;
  frameDurationSec: number;
}

/**
 * Sequential reader for playback: decodes ahead from a start time and hands out the sample covering
 * a requested source time without waiting (the caller draws whatever is ready; misses count as late).
 */
export class FrameReader {
  private queue: VideoSample[] = [];
  private gen: AsyncGenerator<VideoSample, void, unknown> | null = null;
  private filling = false;
  private done = false;
  current: VideoSample | null = null;
  private h: MediaHandle;
  private startSec: number;
  private ahead: number;
  constructor(h: MediaHandle, startSec: number, ahead = 10) { this.h = h; this.startSec = startSec; this.ahead = ahead;
    frameStats.readers++;
    frameStats.liveReaders.add(this);
    if (h.sink) this.gen = h.sink.samples(Math.max(0, startSec));
    void this.fill();
  }

  private disposed = false;

  private async fill(): Promise<void> {
    if (this.filling || this.done || !this.gen || this.disposed) return;
    this.filling = true;
    try {
      while (this.queue.length < this.ahead) {
        const r = await this.gen.next();
        if (r.done) { this.done = true; break; }
        const s = track(r.value);
        // Disposed while this decode was in flight: hand the sample straight back.
        if (this.disposed) { release(s); break; }
        this.queue.push(s);
      }
    } catch {
      this.done = true;
    } finally { this.filling = false; }
  }

  /** Returns the newest decoded sample whose timestamp is <= srcSec (or null if none is ready yet). */
  frameAt(srcSec: number): { sample: VideoSample | null; late: boolean } {
    const eps = this.h.frameDurationSec * 0.25;
    while (this.queue.length && this.queue[0]!.timestamp <= srcSec + eps) {
      release(this.current);
      this.current = this.queue.shift()!;
    }
    void this.fill();
    const late = !this.current || srcSec - this.current.timestamp > this.h.frameDurationSec * 1.5;
    return { sample: this.current, late };
  }

  get exhausted(): boolean { return this.done && this.queue.length === 0; }

  /** Wait until the sample covering srcSec has been decoded (offline rendering). */
  async frameAtExact(srcSec: number): Promise<VideoSample | null> {
    const eps = this.h.frameDurationSec * 0.25;
    for (;;) {
      const last = this.queue[this.queue.length - 1];
      const haveAhead = last && last.timestamp > srcSec + eps;
      if (haveAhead || this.done) break;
      if (this.filling) await new Promise((r) => setTimeout(r, 0));
      else await this.fill();
    }
    return this.frameAt(srcSec).sample;
  }

  get held(): number { return this.queue.length + (this.current ? 1 : 0); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    frameStats.liveReaders.delete(this);
    release(this.current);
    this.current = null;
    for (const s of this.queue) release(s);
    this.queue = [];
    this.done = true;
    const gen = this.gen;
    this.gen = null;
    // Let any in-flight next() finish (it releases its sample) before closing the generator.
    const close = () => { void gen?.return(undefined).catch(() => undefined); };
    if (this.filling) setTimeout(close, 50); else close();
  }
}

/** Opens media once and serves exact-time samples (scrubbing, export) and sequential readers (playback). */
export class MediaPool {
  private handles = new Map<string, Promise<MediaHandle>>();
  private cache = new Map<string, VideoSample>();
  private cacheOrder: string[] = [];
  private pending = new Map<string, Promise<VideoSample | null>>();
  private cacheSize: number;
  constructor(cacheSize = 24) { this.cacheSize = cacheSize;}

  open(path: string): Promise<MediaHandle> {
    let h = this.handles.get(path);
    if (!h) {
      h = (async () => {
        const input = new Input({ source: new UrlSource(mediaUrl(path)), formats: ALL_FORMATS });
        const video = await input.getPrimaryVideoTrack();
        const audio = await input.getPrimaryAudioTrack();
        const sink = video && (await video.canDecode()) ? new VideoSampleSink(video) : null;
        const durationSec = await input.computeDuration();
        let frameDurationSec = 1 / 30;
        if (video) {
          const stats = await video.computePacketStats(60).catch(() => null);
          if (stats && stats.averagePacketRate > 0) frameDurationSec = 1 / stats.averagePacketRate;
        }
        return {
          key: path, path, input, video, audio, sink,
          width: video?.displayWidth ?? 0, height: video?.displayHeight ?? 0, rotation: video?.rotation ?? 0,
          durationSec, frameDurationSec,
        };
      })();
      this.handles.set(path, h);
      h.catch(() => this.handles.delete(path));
    }
    return h;
  }

  /**
   * Exact frame at a source time, as a VideoFrame the caller owns (and must close). Taking the copy
   * synchronously at lookup means cache eviction by an overlapping request can never close it under us.
   */
  async frameAt(path: string, srcSec: number): Promise<{ frame: VideoFrame; width: number; height: number } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.sampleAt(path, srcSec);
      if (!s) return null;
      try { return { frame: s.toVideoFrame(), width: s.displayWidth, height: s.displayHeight }; }
      catch { /* evicted between resolve and use: fetch again */ }
    }
    return null;
  }

  /** Exact sample at a source time (seconds). Owned by the cache: prefer frameAt() outside this class. */
  async sampleAt(path: string, srcSec: number): Promise<VideoSample | null> {
    const h = await this.open(path);
    if (!h.sink) return null;
    const frame = Math.floor(srcSec / h.frameDurationSec + 1e-4);
    const key = `${path}#${frame}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    // Overlapping requests for the same frame share one decode.
    const pending = this.pending.get(key);
    if (pending) return pending;
    const sink = h.sink;
    const job = (async () => {
      const s = await sink.getSample(Math.max(0, (frame + 0.5) * h.frameDurationSec));
      if (!s) return null;
      track(s);
      const dup = this.cache.get(key);
      if (dup) { release(s); return dup; }
      this.cache.set(key, s);
      this.cacheOrder.push(key);
      return s;
    })();
    this.pending.set(key, job);
    let s: VideoSample | null;
    try { s = await job; } finally { this.pending.delete(key); }
    if (!s) return null;
    while (this.cacheOrder.length > this.cacheSize) {
      const old = this.cacheOrder.shift()!;
      release(this.cache.get(old));
      this.cache.delete(old);
    }
    return s;
  }

  async reader(path: string, startSec: number): Promise<FrameReader> {
    return new FrameReader(await this.open(path), startSec);
  }

  async audioSink(path: string): Promise<AudioBufferSink | null> {
    const h = await this.open(path);
    return h.audio && (await h.audio.canDecode()) ? new AudioBufferSink(h.audio) : null;
  }

  clearCache(): void {
    for (const s of this.cache.values()) release(s);
    this.cache.clear();
    this.cacheOrder = [];
  }

  dispose(): void {
    this.clearCache();
    for (const h of this.handles.values()) void h.then((x) => x.input.dispose?.()).catch(() => undefined);
    this.handles.clear();
  }
}
