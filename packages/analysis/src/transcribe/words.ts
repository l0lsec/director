import { normalizeWord } from '@director/engine';

export interface TWord { text: string; start: number; end: number; p?: number }

/** Parse whisper.cpp -ojf output produced with -ml 1 -sow (one segment per word). Times in microseconds. */
export function parseWhisperJson(json: { transcription?: Array<{ text: string; offsets: { from: number; to: number }; tokens?: Array<{ text: string; p?: number }> }> }): TWord[] {
  const out: TWord[] = [];
  for (const seg of json.transcription ?? []) {
    const text = seg.text.trim();
    if (!text || /^\[.*\]$/.test(text) || /^\(.*\)$/.test(text)) continue;
    const toks = (seg.tokens ?? []).filter((t) => !t.text.startsWith('['));
    const p = toks.length ? toks.reduce((s, t) => s + (t.p ?? 1), 0) / toks.length : undefined;
    // Without -sow, a segment may hold several words: split evenly by characters as a fallback.
    const parts = text.split(/\s+/);
    const from = seg.offsets.from * 1000, to = seg.offsets.to * 1000;
    if (parts.length === 1) { out.push({ text, start: from, end: to, p }); continue; }
    const total = parts.reduce((n, w) => n + w.length, 0) || 1;
    let t = from;
    for (const w of parts) { const d = ((to - from) * w.length) / total; out.push({ text: w, start: Math.round(t), end: Math.round(t + d), p }); t += d; }
  }
  return out;
}

/**
 * Sharpen word boundaries with the audio: whisper places a word's start at the previous word's end.
 * Each start moves to the first speech onset after it (within the word), each end back to the last
 * voiced frame. `energy` is RMS per 10 ms frame.
 */
export function refineWithEnergy(words: TWord[], energy: Float32Array, frameUs = 10_000): TWord[] {
  if (!energy.length) return words;
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const peak = sorted[Math.floor(sorted.length * 0.98)] ?? 1;
  const thr = floor + (peak - floor) * 0.08;
  const voiced = (i: number) => (energy[i] ?? 0) > thr;
  return words.map((w) => {
    const a = Math.max(0, Math.floor(w.start / frameUs));
    const b = Math.min(energy.length - 1, Math.ceil(w.end / frameUs));
    let s = a;
    while (s < b && !voiced(s)) s++;
    let e = b;
    while (e > s && !voiced(e)) e--;
    if (s >= b) return w; // no speech found: keep whisper's guess
    return { ...w, start: s * frameUs, end: Math.max((e + 1) * frameUs, s * frameUs + 40_000) };
  });
}

export function rmsFrames(pcm: Float32Array | Int16Array, sampleRate: number, frameUs = 10_000): Float32Array {
  const n = Math.round((sampleRate * frameUs) / 1e6);
  const out = new Float32Array(Math.ceil(pcm.length / n));
  const scale = pcm instanceof Int16Array ? 1 / 32768 : 1;
  for (let f = 0; f < out.length; f++) {
    let s = 0;
    const end = Math.min(pcm.length, (f + 1) * n);
    for (let i = f * n; i < end; i++) { const v = pcm[i]! * scale; s += v * v; }
    out[f] = Math.sqrt(s / Math.max(1, end - f * n));
  }
  return out;
}

export const norm = normalizeWord;

interface DtwToken { text: string; t_dtw?: number; p?: number; offsets?: { from: number; to: number } }

/**
 * Words from whisper.cpp -ojf output run with DTW (-dtw <model> -nfa). DTW token times mark where each
 * token ends; a word ends at its last token. Starts come from the audio: the first voiced frame after
 * the previous word ends. Times in microseconds.
 */
export function wordsFromDtw(json: { transcription?: Array<{ tokens?: DtwToken[] }> }, energy: Float32Array | null, frameUs = 10_000): TWord[] {
  const raw: Array<{ text: string; end: number; ps: number[]; from: number }> = [];
  for (const seg of json.transcription ?? []) {
    for (const t of seg.tokens ?? []) {
      if (!t.text || t.text.startsWith('[') || t.text.startsWith('<|')) continue;
      const end = t.t_dtw != null && t.t_dtw >= 0 ? t.t_dtw * 10_000 : (t.offsets?.to ?? 0) * 1000;
      const startsWord = /^\s/.test(t.text) || raw.length === 0;
      if (startsWord) raw.push({ text: t.text.trim(), end, ps: [t.p ?? 1], from: (t.offsets?.from ?? 0) * 1000 });
      else { const w = raw[raw.length - 1]!; w.text += t.text; w.end = Math.max(w.end, end); w.ps.push(t.p ?? 1); }
    }
  }
  const words = raw.filter((w) => /[a-z0-9]/i.test(w.text));
  let thr = 0;
  if (energy && energy.length) {
    const sorted = Array.from(energy).sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
    const peak = sorted[Math.floor(sorted.length * 0.98)] ?? 1;
    thr = floor + (peak - floor) * 0.08;
  }
  const out: TWord[] = [];
  let prevEnd = 0;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    let end = Math.max(w.end, prevEnd + 20_000);
    let start = Math.max(prevEnd, w.from > prevEnd && w.from < end ? w.from : prevEnd);
    if (energy && energy.length) {
      const a = Math.max(0, Math.floor((i === 0 ? Math.max(0, end - 1_500_000) : prevEnd) / frameUs));
      const b = Math.min(energy.length - 1, Math.ceil(end / frameUs));
      let s = a;
      // The previous word may have been ended a few frames before its voice did. If the search starts on that
      // short tail and a real pause (120 ms or more) follows, give the tail back to that word and look past the pause.
      if (i > 0) {
        let t = a;
        while (t < b && (energy[t] ?? 0) > thr) t++;
        let q = t;
        while (q < b && (energy[q] ?? 0) <= thr) q++;
        if (t > a && t - a <= 15 && q - t >= 12 && q < b) {
          const prev = out[out.length - 1];
          if (prev) prev.end = Math.max(prev.end, t * frameUs);
          s = t;
        }
      }
      while (s < b && (energy[s] ?? 0) <= thr) s++;
      if (s < b) start = s * frameUs;
      // DTW can place a word's end inside the following pause or word. End the word at the first
      // sustained silence (120 ms) after it has been voiced for 80 ms, if that comes before the DTW end.
      const limit = Math.min(energy.length - 1, Math.ceil((end + 60_000) / frameUs));
      let run = 0, voicedSoFar = 0, cut = -1;
      for (let f = s; f <= limit; f++) {
        if ((energy[f] ?? 0) > thr) { voicedSoFar++; run = 0; } else if (voicedSoFar >= 8 && ++run >= 12) { cut = f - run + 1; break; }
      }
      if (cut > s) end = cut * frameUs;
      else {
        let e = limit;
        while (e > s && (energy[e] ?? 0) <= thr) e--;
        if (e > s) end = Math.min(end + 60_000, (e + 1) * frameUs);
      }
    }
    if (end <= start) end = start + 40_000;
    out.push({ text: w.text, start, end, p: w.ps.reduce((x, y) => x + y, 0) / w.ps.length });
    prevEnd = end;
  }
  return out;
}

/** 16-bit PCM samples from a WAV file, found by walking the RIFF chunks (headers vary in size). */
export function wavPcm16(buf: Uint8Array): { samples: Int16Array; sampleRate: number; channels: number } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (o: number) => String.fromCharCode(buf[o]!, buf[o + 1]!, buf[o + 2]!, buf[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12, sampleRate = 0, channels = 1;
  while (o + 8 <= buf.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') { channels = dv.getUint16(o + 10, true); sampleRate = dv.getUint32(o + 12, true); }
    if (id === 'data') {
      const start = o + 8;
      const len = Math.min(size, buf.length - start) & ~1;
      const copy = new Int16Array(len / 2);
      for (let i = 0; i < copy.length; i++) copy[i] = dv.getInt16(start + i * 2, true);
      return { samples: copy, sampleRate, channels };
    }
    o += 8 + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}
