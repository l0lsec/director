import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { denoise } from '@director/media/audio/denoise';
import { wavPcm16 } from '@director/analysis';
import { runJobOk } from '../jobs/runner';
import { requireSidecar } from '../jobs/sidecars';
import { probeMedia } from '../jobs/probe';
import { quickHash, cacheDirFor } from '../media/importer';
import { mediaCacheRoot } from '../media/handlers';
import { getSetting, setSetting } from '../settings';

function writeWavF32(path: string, chans: Float32Array[], rate: number): void {
  const n = chans[0]!.length, ch = chans.length;
  const buf = Buffer.alloc(44 + n * ch * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * ch * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(ch, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * ch * 2, 28); buf.writeUInt16LE(ch * 2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * ch * 2, 40);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(chans[c]![i]! * 32767))), 44 + (i * ch + c) * 2);
  writeFileSync(path, buf);
}

async function decodeMono(path: string, rate: number, dir: string): Promise<Float32Array> {
  const tmp = join(dir, `decode-${rate}.wav`);
  await runJobOk({ kind: 'decode', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', String(rate), '-c:a', 'pcm_s16le', tmp] });
  const { samples } = wavPcm16(readFileSync(tmp));
  return Float32Array.from(samples, (v) => v / 32768);
}

/** Onset times (seconds) by spectral flux with an adaptive threshold. */
export function detectOnsets(x: Float32Array, rate: number, minGapSec = 0.12): number[] {
  const N = 512, hop = 64;
  const frames = Math.floor((x.length - N) / hop);
  const flux = new Float32Array(Math.max(0, frames));
  let prev = new Float32Array(N / 2);
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  // Band energies via a cheap filterbank (16 bands of a direct DFT would be slow; use time-domain band split by differencing).
  for (let f = 0; f < frames; f++) {
    const cur = new Float32Array(N / 2);
    for (let b = 0; b < N / 2; b++) {
      // Energy of the windowed, first-differenced signal in sub-blocks: a high-frequency-weighted onset cue.
      const i = f * hop + b * 2;
      const d = (x[i + 1] ?? 0) * win[b * 2 + 1]! - (x[i] ?? 0) * win[b * 2]!;
      cur[b] = d * d;
    }
    let sum = 0;
    for (let b = 0; b < N / 2; b++) sum += Math.max(0, cur[b]! - prev[b]!);
    flux[f] = sum;
    prev = cur;
  }
  const out: number[] = [];
  const w = Math.round((0.1 * rate) / hop);
  for (let f = 1; f < frames - 1; f++) {
    let mean = 0, cnt = 0;
    for (let k = Math.max(0, f - w); k <= Math.min(frames - 1, f + w); k++) { mean += flux[k]!; cnt++; }
    mean /= cnt;
    const isPeak = flux[f]! > flux[f - 1]! && flux[f]! >= flux[f + 1]! && flux[f]! > mean * 2.5 + 1e-6;
    if (!isPeak) continue;
    const t = (f * hop + N / 2) / rate;
    if (out.length && t - out[out.length - 1]! < minGapSec) continue;
    out.push(t);
  }
  return out;
}

/** Refine each onset to the first sample where the signal rises above a fraction of its local peak. */
export function refineOnsets(x: Float32Array, rate: number, onsets: number[]): number[] {
  return onsets.map((t) => {
    const a = Math.max(0, Math.round((t - 0.03) * rate)), b = Math.min(x.length, Math.round((t + 0.03) * rate));
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, Math.abs(x[i]!));
    for (let i = a; i < b; i++) if (Math.abs(x[i]!) > peak * 0.3) return i / rate;
    return t;
  });
}

const AUDIO_EXT = new Set(['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.aif', '.aiff']);

export const audioHandlers = {
  /** Denoise and/or enhance a clip's audio into a new cached WAV. */
  'audio:process': async (i: { path: string; denoise?: boolean; enhance?: boolean; projectDir?: string }) => {
    const dir = cacheDirFor(mediaCacheRoot(i.projectDir), quickHash(i.path));
    const tag = `${i.denoise ? 'dn' : ''}${i.enhance ? 'en' : ''}` || 'copy';
    const out = join(dir, `voice-${tag}.wav`);
    if (existsSync(out)) return { path: out, probe: await probeMedia(out) };
    let work = join(dir, 'voice-src48.wav');
    await runJobOk({ kind: 'decode', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-i', i.path, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', work] });
    if (i.denoise) {
      const { samples } = wavPcm16(readFileSync(work));
      const y = denoise(Float32Array.from(samples, (v) => v / 32768));
      work = join(dir, 'voice-dn.tmp.wav');
      writeWavF32(work, [y], 48000);
    }
    if (i.enhance) {
      const chain = 'highpass=f=80,equalizer=f=200:t=q:w=1:g=-2,equalizer=f=3200:t=q:w=1.2:g=3,acompressor=threshold=-20dB:ratio=3:attack=8:release=120:makeup=3,deesser=i=0.4,alimiter=limit=0.95';
      await runJobOk({ kind: 'enhance', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-i', work, '-af', chain, '-ar', '48000', '-c:a', 'pcm_s16le', out] });
    } else {
      writeFileSync(out, readFileSync(work));
    }
    return { path: out, probe: await probeMedia(out) };
  },
  /** Beat/onset times (seconds, source time) of an audio file. */
  'audio:beats': async (i: { path: string; projectDir?: string }) => {
    const dir = cacheDirFor(mediaCacheRoot(i.projectDir), quickHash(i.path));
    const x = await decodeMono(i.path, 22050, dir);
    return refineOnsets(x, 22050, detectOnsets(x, 22050));
  },
  'audiolib:folders': () => getSetting<string[]>('audioLibrary.folders', []),
  'audiolib:setFolders': (i: { folders: string[] }) => { setSetting('audioLibrary.folders', i.folders); return true; },
  /** Scan the music and SFX folders (two levels deep) for audio with durations. */
  'audiolib:scan': async (i: { folders?: string[] }) => {
    const folders = i.folders ?? getSetting<string[]>('audioLibrary.folders', []);
    const items: Array<{ path: string; name: string; folder: string; durationUs: number; kind: 'music' | 'sfx' }> = [];
    const walk = async (d: string, root: string, depth: number) => {
      let entries: string[] = [];
      try { entries = readdirSync(d); } catch { return; }
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        const p = join(d, e);
        let st; try { st = statSync(p); } catch { continue; }
        if (st.isDirectory()) { if (depth < 2) await walk(p, root, depth + 1); continue; }
        if (!AUDIO_EXT.has(extname(p).toLowerCase())) continue;
        const pr = await probeMedia(p).catch(() => null);
        if (!pr || !pr.audio) continue;
        items.push({ path: p, name: basename(p), folder: root, durationUs: pr.durationUs, kind: /sfx|effect|whoosh|hit|riser/i.test(p) || pr.durationUs < 8_000_000 ? 'sfx' : 'music' });
      }
    };
    for (const f of folders) { mkdirSync(f, { recursive: true }); await walk(f, f, 0); }
    return items.sort((a, b) => a.name.localeCompare(b.name));
  },
};
