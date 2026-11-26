import { AUDIO_LANES, clipDuration, clipEnd, dbToGain, evalAnim, rampIntegral, type Clip, type Lane, type Project } from '@director/engine';
import type { MediaPool } from '../decode/pool';
import { timeStretch } from './stretch';
import { duckingPoints, speechIntervals } from './ducking';

export interface AudioSourceInfo { clip: Clip; lane: Lane; path: string }

/** Clips that make sound: audio lanes, plus unmuted video clips on visual lanes. */
export function audibleClips(doc: Project): AudioSourceInfo[] {
  const anySolo = doc.lanes.some((l) => l.solo);
  const out: AudioSourceInfo[] = [];
  for (const lane of doc.lanes) {
    if (lane.muted || (anySolo && !lane.solo)) continue;
    for (const clip of lane.clips) {
      if (!clip.enabled || clip.kind !== 'media' || !clip.mediaId || !clip.audio || clip.audio.muted) continue;
      const m = doc.media[clip.mediaId];
      if (!m || !m.hasAudio || clip.freezeAt != null) continue;
      if (!AUDIO_LANES.has(lane.kind) && !clip.audio) continue;
      out.push({ clip, lane, path: m.path });
    }
  }
  return out;
}

/** Decodes whole audio tracks once per file (and caches reversed / time-stretched variants). */
export class AudioCache {
  private raw = new Map<string, Promise<AudioBuffer | null>>();
  private variants = new Map<string, Promise<AudioBuffer | null>>();
  private pool: MediaPool;
  private ctxFactory: (ch: number, len: number, rate: number) => AudioBuffer;
  constructor(pool: MediaPool, ctxFactory: (ch: number, len: number, rate: number) => AudioBuffer) { this.pool = pool; this.ctxFactory = ctxFactory;}

  get(path: string): Promise<AudioBuffer | null> {
    let p = this.raw.get(path);
    if (!p) {
      p = (async () => {
        const sink = await this.pool.audioSink(path);
        if (!sink) return null;
        const chunks: AudioBuffer[] = [];
        let first = Infinity;
        for await (const w of sink.buffers()) { chunks.push(w.buffer); first = Math.min(first, w.timestamp); }
        if (!chunks.length) return null;
        const rate = chunks[0]!.sampleRate;
        const ch = Math.max(...chunks.map((c) => c.numberOfChannels));
        // Leading offset (for streams that start after 0) is kept as silence so source times line up.
        const lead = Math.max(0, Math.round((Number.isFinite(first) ? first : 0) * rate));
        const len = lead + chunks.reduce((n, c) => n + c.length, 0);
        const out = this.ctxFactory(ch, len, rate);
        let off = lead;
        for (const c of chunks) {
          for (let k = 0; k < ch; k++) out.getChannelData(k).set(c.getChannelData(Math.min(k, c.numberOfChannels - 1)), off);
          off += c.length;
        }
        return out;
      })();
      this.raw.set(path, p);
    }
    return p;
  }

  /** Reversed and/or pitch-preserving time-stretched copy of [inSec, outSec). */
  variant(path: string, inSec: number, outSec: number, rate: number, reverse: boolean, preservePitch: boolean): Promise<AudioBuffer | null> {
    const key = `${path}|${inSec.toFixed(4)}|${outSec.toFixed(4)}|${rate}|${reverse}|${preservePitch}`;
    let p = this.variants.get(key);
    if (!p) {
      p = this.get(path).then((buf) => {
        if (!buf) return null;
        const a = Math.max(0, Math.floor(inSec * buf.sampleRate));
        const b = Math.min(buf.length, Math.ceil(outSec * buf.sampleRate));
        const chans: Float32Array[] = [];
        for (let k = 0; k < buf.numberOfChannels; k++) {
          let d: Float32Array<ArrayBuffer> = buf.getChannelData(k).slice(a, b);
          if (reverse) d.reverse();
          if (preservePitch && Math.abs(rate - 1) > 1e-3) d = timeStretch(d, rate, buf.sampleRate);
          chans.push(d);
        }
        const out = this.ctxFactory(chans.length, chans[0]!.length || 1, buf.sampleRate);
        chans.forEach((d, k) => out.getChannelData(k).set(d));
        return out;
      });
      this.variants.set(key, p);
    }
    return p;
  }

  clear(): void { this.raw.clear(); this.variants.clear(); }
}

/** Gain envelope (linear gain) at a time relative to the clip start, including fades. */
export function clipGainAt(clip: Clip, tRel: number): number {
  const a = clip.audio!;
  let g = dbToGain(evalAnim(a.gainDb, tRel));
  const d = clipDuration(clip);
  if (a.fadeIn > 0 && tRel < a.fadeIn) g *= Math.max(0, tRel / a.fadeIn);
  if (a.fadeOut > 0 && tRel > d - a.fadeOut) g *= Math.max(0, (d - tRel) / a.fadeOut);
  return g;
}

export interface MixOptions { fromUs: number; toUs?: number; startAt: number; master?: AudioNode; ducking?: (clip: Clip, lane: Lane) => Array<{ t: number; gain: number }> | null }

/**
 * Build the mix graph on any BaseAudioContext (live or offline). Returns the created nodes so a
 * live player can stop them. Same code renders preview and export.
 */
export async function buildMix(ctx: BaseAudioContext, doc: Project, cache: AudioCache, o: MixOptions): Promise<AudioScheduledSourceNode[]> {
  const nodes: AudioScheduledSourceNode[] = [];
  const dest = o.master ?? ctx.destination;
  // Music marked "duck under voice" dips automatically wherever someone is speaking.
  const intervals = speechIntervals(doc);
  const ducking = o.ducking ?? ((clip: Clip, lane: Lane) => duckingPoints(doc, clip, lane, intervals));
  for (const { clip, lane, path } of audibleClips(doc)) {
    const start = clip.start;
    const end = clipEnd(clip);
    if (end <= o.fromUs || (o.toUs != null && start >= o.toUs)) continue;
    const rate = clip.speed.kind === 'constant' ? clip.speed.rate : rampIntegral(clip.speed.points, 1);
    const pitchFix = clip.speed.preservePitch && clip.speed.kind === 'constant' && Math.abs(rate - 1) > 1e-3;
    const needsVariant = clip.reverse || pitchFix;
    const buf = needsVariant ? await cache.variant(path, clip.in / 1e6, clip.out / 1e6, rate, clip.reverse, pitchFix) : await cache.get(path);
    if (!buf) continue;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const offsetUs = Math.max(0, o.fromUs - start); // timeline time already passed in this clip
    const when = o.startAt + Math.max(0, start - o.fromUs) / 1e6;
    const playDur = (end - start - offsetUs) / 1e6;
    let bufferOffset: number;
    if (needsVariant) {
      src.playbackRate.value = pitchFix ? 1 : rate;
      bufferOffset = pitchFix ? offsetUs / 1e6 : (offsetUs / 1e6) * rate;
    } else if (clip.speed.kind === 'constant') {
      src.playbackRate.value = rate;
      bufferOffset = clip.in / 1e6 + (offsetUs / 1e6) * rate;
    } else {
      // Speed ramp: automate playback rate (pitch follows speed, as in most editors).
      const d = clipDuration(clip);
      for (let k = 0; k <= 40; k++) {
        const x = k / 40;
        const tt = (x * d) / 1e6;
        if (tt * 1e6 < offsetUs) continue;
        const p = clip.speed.points;
        let r = p[p.length - 1]!.rate;
        for (let i = 0; i < p.length - 1; i++) if (x >= p[i]!.at && x <= p[i + 1]!.at) { const s = (x - p[i]!.at) / Math.max(1e-6, p[i + 1]!.at - p[i]!.at); r = p[i]!.rate + (p[i + 1]!.rate - p[i]!.rate) * s; break; }
        src.playbackRate.setValueAtTime(r, when + tt - offsetUs / 1e6);
      }
      bufferOffset = clip.in / 1e6 + ((clip.out - clip.in) * (rampIntegral(clip.speed.points, offsetUs / d) / rampIntegral(clip.speed.points, 1))) / 1e6;
    }
    const gain = ctx.createGain();
    // Gain envelope sampled every 20 ms over the part that will play.
    const stepUs = 20_000;
    const len = end - start;
    // Envelope points every 20 ms plus exactly at fade boundaries and the clip edges, so short fades
    // (the 10 ms joins AutoCut adds) are rendered rather than skipped between samples.
    const times = new Set<number>();
    for (let tr = offsetUs + stepUs; tr < len; tr += stepUs) times.add(tr);
    const a = clip.audio!;
    for (const tr of [a.fadeIn, len - a.fadeOut, len]) if (tr > offsetUs && tr <= len) times.add(tr);
    gain.gain.setValueAtTime(clipGainAt(clip, offsetUs), when);
    for (const tr of [...times].sort((x, y) => x - y)) gain.gain.linearRampToValueAtTime(tr >= len && a.fadeOut > 0 ? 0 : clipGainAt(clip, tr), when + (tr - offsetUs) / 1e6);
    let last: AudioNode = gain;
    const duck = ducking(clip, lane);
    if (duck && duck.length) {
      const dg = ctx.createGain();
      // Start at the envelope's value at the play position, then follow its points.
      const startT = start + offsetUs;
      let g0 = duck[0]!.gain;
      for (let k = 0; k < duck.length - 1; k++) { const a = duck[k]!, b = duck[k + 1]!; if (startT >= a.t && startT <= b.t) { g0 = b.t === a.t ? b.gain : a.gain + ((b.gain - a.gain) * (startT - a.t)) / (b.t - a.t); break; } if (startT > b.t) g0 = b.gain; }
      dg.gain.setValueAtTime(g0, when);
      for (const pt of duck) if (pt.t > startT && pt.t <= end) dg.gain.linearRampToValueAtTime(pt.gain, when + (pt.t - startT) / 1e6);
      gain.connect(dg);
      last = dg;
    }
    if (clip.audio!.pan !== 0) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = clip.audio!.pan;
      last.connect(pan);
      last = pan;
    }
    src.connect(gain);
    last.connect(dest);
    src.start(when, Math.max(0, bufferOffset), Math.max(0, playDur * (needsVariant && !pitchFix ? rate : pitchFix ? 1 : rate)));
    nodes.push(src);
  }
  return nodes;
}
