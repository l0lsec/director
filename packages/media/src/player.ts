import { timelineDuration, type Project } from '@director/engine';
import { Compositor } from './compositor/gl';
import { MediaPool, FrameReader, frameStats } from './decode/pool';
import { AudioCache, buildMix } from './audio/engine';
import { TextRenderer } from './text/render';
import { renderFrame, loadLuts, type FrameSource } from './render';
import type { VisualPlan } from './timeline/plan';
import { mediaUrl } from './url';

export interface PlayerStats { framesDrawn: number; framesLate: number; lastSeekMs: number; openFrames: number }

const images = new Map<string, Promise<ImageBitmap | null>>();
function loadImage(path: string): Promise<ImageBitmap | null> {
  let p = images.get(path);
  if (!p) {
    p = fetch(mediaUrl(path)).then((r) => r.blob()).then((b) => createImageBitmap(b, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' })).catch(() => null);
    images.set(path, p);
  }
  return p;
}
const imageReady = new Map<string, ImageBitmap>();

/** Interactive preview: audio-clocked playback with decode-ahead readers, exact-frame scrubbing. */
export class Player {
  readonly comp: Compositor;
  readonly pool: MediaPool;
  readonly text = new TextRenderer();
  readonly ctx: AudioContext;
  readonly audio: AudioCache;
  private master: GainNode;
  private doc: Project | null = null;
  private t = 0;
  private playing = false;
  private startCtx = 0;
  private startT = 0;
  private raf = 0;
  private readers = new Map<string, { reader: FrameReader; path: string; lastSrc: number }>();
  private nodes: AudioScheduledSourceNode[] = [];
  private seekToken = 0;
  private listeners = new Set<(t: number, playing: boolean) => void>();
  scale = 0.5;
  loop = false;
  stats: PlayerStats = { framesDrawn: 0, framesLate: 0, lastSeekMs: 0, openFrames: 0 };

  constructor(canvas: HTMLCanvasElement, opts: { pool?: MediaPool; ctx?: AudioContext } = {}) {
    this.comp = new Compositor(canvas);
    this.pool = opts.pool ?? new MediaPool();
    this.ctx = opts.ctx ?? new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.audio = new AudioCache(this.pool, (ch, len, rate) => new AudioBuffer({ numberOfChannels: ch, length: len, sampleRate: rate }));
  }

  get time(): number { return this.t; }
  get isPlaying(): boolean { return this.playing; }
  get duration(): number { return this.doc ? timelineDuration(this.doc) : 0; }
  onTime(fn: (t: number, playing: boolean) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const l of this.listeners) l(this.t, this.playing); }

  setVolume(v: number): void { this.master.gain.value = v; }

  setDoc(doc: Project): void {
    const prev = this.doc;
    this.doc = doc;
    if (this.playing && prev !== doc) { this.stopAudio(); void this.startAudio(); }
    if (!this.playing) void this.seek(this.t);
  }

  private latestSeek: Promise<void> = Promise.resolve();

  /**
   * Render the exact frame at t (waits for decode). Coalesces rapid calls: a seek that a newer one
   * supersedes resolves when the newest render has landed, so callers never see a stale canvas.
   */
  seek(t: number): Promise<void> {
    const p = this.seekOnce(t);
    this.latestSeek = p;
    return p;
  }

  private async seekOnce(t: number): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    this.t = Math.max(0, t);
    const token = ++this.seekToken;
    const started = performance.now();
    await loadLuts(doc, this.comp);
    const { planFrame } = await import('./timeline/plan');
    const { withMattes } = await import('./timeline/plan');
    const plans = withMattes(planFrame(doc, this.t));
    const ready = new Map<string, FrameSource>();
    await Promise.all(plans.map(async (p) => {
      if (p.kind === 'video' && p.path) {
        const f = await this.pool.frameAt(p.path, p.srcSec ?? 0).catch(() => null);
        if (f) ready.set(p.clip.id, { source: f.frame, width: f.width, height: f.height });
      } else if (p.kind === 'image' && p.path) {
        const img = await loadImage(p.path);
        if (img) { imageReady.set(p.path, img); ready.set(p.clip.id, { source: img, width: img.width, height: img.height }); }
      }
    }));
    if (token !== this.seekToken || this.playing) {
      for (const f of ready.values()) if (f.source instanceof VideoFrame) f.source.close();
      if (!this.playing) await this.latestSeek;
      return;
    }
    renderFrame(this.comp, doc, this.t, (p) => ready.get(p.clip.id) ?? null, this.text, this.scale);
    // Only per-seek VideoFrames are ours to close; image bitmaps are cached for reuse.
    for (const f of ready.values()) if (f.source instanceof VideoFrame) f.source.close();
    this.stats.lastSeekMs = performance.now() - started;
    this.stats.openFrames = frameStats.open;
    this.emit();
  }

  async play(): Promise<void> {
    if (!this.doc || this.playing) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (this.t >= this.duration) this.t = 0;
    this.playing = true;
    this.startT = this.t;
    this.startCtx = this.ctx.currentTime + 0.08; // small lead so audio and first frame line up
    await this.startAudio();
    // Paused while the audio graph was being built: tear it down again.
    if (!this.playing) { this.stopAudio(); return; }
    this.loopFrame();
    this.emit();
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.stopAudio();
    this.disposeReaders();
    void this.seek(this.t);
    this.emit();
  }

  toggle(): void { if (this.playing) this.pause(); else void this.play(); }

  private async startAudio(): Promise<void> {
    if (!this.doc) return;
    const from = this.playing ? this.currentPlayTime() : this.t;
    const at = Math.max(this.ctx.currentTime + 0.02, this.startCtx + (from - this.startT) / 1e6);
    this.nodes = await buildMix(this.ctx, this.doc, this.audio, { fromUs: from + (at - (this.startCtx + (from - this.startT) / 1e6)) * 1e6, startAt: at, master: this.master });
  }

  private stopAudio(): void {
    for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } n.disconnect(); }
    this.nodes = [];
  }

  /** Timeline time the listener is hearing now (accounts for output latency). */
  private currentPlayTime(): number {
    const latency = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    return this.startT + Math.max(0, this.ctx.currentTime - this.startCtx - latency) * 1e6;
  }

  private disposeReaders(): void {
    for (const r of this.readers.values()) r.reader.dispose();
    this.readers.clear();
  }

  private loopFrame = (): void => {
    if (!this.playing || !this.doc) return;
    const doc = this.doc;
    this.t = this.currentPlayTime();
    if (this.t >= this.duration) {
      if (this.loop) { this.pause(); this.t = 0; void this.play(); return; }
      this.t = this.duration;
      this.pause();
      return;
    }
    const seen = new Set<string>();
    let late = false;
    const resolve = (p: VisualPlan): FrameSource | null => {
      if (p.kind === 'image' && p.path) {
        const img = imageReady.get(p.path);
        if (!img) void loadImage(p.path).then((b) => { if (b) imageReady.set(p.path!, b); });
        return img ? { source: img, width: img.width, height: img.height } : null;
      }
      if (p.kind !== 'video' || !p.path) return null;
      seen.add(p.clip.id);
      let r = this.readers.get(p.clip.id);
      const src = p.srcSec ?? 0;
      const backwards = r && src < r.lastSrc - 0.05;
      if (!r || r.path !== p.path || backwards || p.clip.reverse) {
        r?.reader.dispose();
        if (p.clip.reverse) {
          // Reverse clips: exact lookups (cached), drawn when ready.
          void this.pool.frameAt(p.path, src).then((f) => f?.frame.close());
          this.readers.delete(p.clip.id);
          return null;
        }
        const reader = new FrameReader(this.poolHandle(p.path), src);
        r = { reader, path: p.path, lastSrc: src };
        this.readers.set(p.clip.id, r);
      }
      r.lastSrc = src;
      const { sample, late: isLate } = r.reader.frameAt(src);
      if (isLate) late = true;
      return sample ? { source: sample as unknown as TexImageSource, width: sample.displayWidth, height: sample.displayHeight } : null;
    };
    renderFrame(this.comp, doc, this.t, (p) => {
      const f = resolve(p);
      if (!f) return null;
      // VideoSample is not a TexImageSource; convert per draw (cheap: wraps the same VideoFrame).
      const s = f.source as unknown as { toVideoFrame?: () => VideoFrame };
      if (s.toVideoFrame) { const vf = s.toVideoFrame(); queueMicrotask(() => vf.close()); return { source: vf, width: f.width, height: f.height }; }
      return f;
    }, this.text, this.scale);
    for (const [id, r] of this.readers) if (!seen.has(id)) { r.reader.dispose(); this.readers.delete(id); }
    this.stats.framesDrawn++;
    if (late) this.stats.framesLate++;
    this.stats.openFrames = frameStats.open;
    this.emit();
    this.raf = requestAnimationFrame(this.loopFrame);
  };

  private handles = new Map<string, Awaited<ReturnType<MediaPool['open']>>>();
  private poolHandle(path: string): Awaited<ReturnType<MediaPool['open']>> {
    const h = this.handles.get(path);
    if (h) return h;
    throw new Error(`media not prepared: ${path}`);
  }

  /** Open every media file in the doc so playback can start readers synchronously. */
  async prepare(doc: Project = this.doc!): Promise<void> {
    const paths = new Set<string>();
    for (const m of Object.values(doc.media)) if (m.hasVideo && m.kind === 'video') paths.add(m.proxyPath ?? m.path);
    for (const l of doc.lanes) for (const c of l.clips) for (const e of c.effects) if (e.type === 'matte' && typeof e.params.path === 'string') paths.add(e.params.path);
    await Promise.all([...paths].map(async (p) => { if (!this.handles.has(p)) this.handles.set(p, await this.pool.open(p)); }));
    await Promise.all(Object.values(doc.media).filter((m) => m.kind === 'image').map((m) => loadImage(m.path).then((b) => { if (b) imageReady.set(m.path, b); })));
    await loadLuts(doc, this.comp);
  }

  resetStats(): void { this.stats = { framesDrawn: 0, framesLate: 0, lastSeekMs: 0, openFrames: frameStats.open }; }

  dispose(): void {
    this.pause();
    this.disposeReaders();
    this.stopAudio();
    this.pool.dispose();
    this.comp.dispose();
    void this.ctx.close();
  }
}
