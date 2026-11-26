/**
 * Speech denoiser: STFT spectral subtraction with a decision-directed Wiener gain.
 * The noise spectrum is learned from the quietest frames (minimum statistics), so no separate
 * noise sample is needed. Pure TypeScript; mono Float32 in and out.
 */

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function ifft(re: Float64Array, im: Float64Array): void {
  for (let i = 0; i < im.length; i++) im[i] = -im[i]!;
  fft(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) { re[i] = re[i]! / n; im[i] = -im[i]! / n; }
}

export interface DenoiseOptions { strength: number; floorDb: number; frame: number }
export const DEFAULT_DENOISE: DenoiseOptions = { strength: 1.5, floorDb: -28, frame: 1024 };

export function denoise(x: Float32Array, opts: Partial<DenoiseOptions> = {}): Float32Array {
  const o = { ...DEFAULT_DENOISE, ...opts };
  const N = o.frame, hop = N / 4, bins = N / 2 + 1;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)); // sqrt-Hann (analysis and synthesis)
  const frames = Math.max(1, Math.ceil((x.length + N) / hop));
  // Pass 1: power spectra, to estimate the noise from the quietest 10% of frames per bin.
  const power: Float64Array[] = [];
  const re = new Float64Array(N), im = new Float64Array(N);
  const frameAt = (f: number) => {
    const start = f * hop - N;
    for (let i = 0; i < N; i++) { const s = start + i; re[i] = s >= 0 && s < x.length ? x[s]! * win[i]! : 0; im[i] = 0; }
    fft(re, im);
  };
  const energies = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    frameAt(f);
    const p = new Float64Array(bins);
    let e = 0;
    for (let k = 0; k < bins; k++) { p[k] = re[k]! * re[k]! + im[k]! * im[k]!; e += p[k]!; }
    power.push(p);
    energies[f] = e;
  }
  const order = [...energies.keys()].sort((a, b) => energies[a]! - energies[b]!);
  const quiet = order.slice(0, Math.max(3, Math.floor(frames * 0.1)));
  const noise = new Float64Array(bins);
  for (const f of quiet) for (let k = 0; k < bins; k++) noise[k] = noise[k]! + power[f]![k]! / quiet.length;
  // Pass 2: decision-directed a-priori SNR -> Wiener gain with a floor; overlap-add.
  const out = new Float64Array(x.length + 2 * N);
  const floor = Math.pow(10, o.floorDb / 20);
  const prevClean = new Float64Array(bins);
  const alpha = 0.98;
  for (let f = 0; f < frames; f++) {
    frameAt(f);
    for (let k = 0; k < bins; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      const nk = noise[k]! * o.strength + 1e-12;
      const post = p / nk;
      const prio = alpha * (prevClean[k]! / nk) + (1 - alpha) * Math.max(post - 1, 0);
      const g = Math.max(floor, prio / (1 + prio));
      prevClean[k] = g * g * p;
      re[k] = re[k]! * g; im[k] = im[k]! * g;
      if (k > 0 && k < N / 2) { re[N - k] = re[k]!; im[N - k] = -im[k]!; }
    }
    ifft(re, im);
    const start = f * hop;
    for (let i = 0; i < N; i++) out[start + i] = out[start + i]! + re[i]! * win[i]!;
  }
  // sqrt-Hann analysis x synthesis at 75% overlap sums to 2: normalize.
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = out[i + N]! / 2;
  return y;
}
