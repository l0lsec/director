/**
 * WSOLA time-stretch: changes duration by 1/rate without changing pitch.
 * rate 2 = twice as fast (half as long). Mono channel in, mono out.
 */
export function timeStretch(input: Float32Array, rate: number, sampleRate: number): Float32Array<ArrayBuffer> {
  if (Math.abs(rate - 1) < 1e-4 || input.length === 0) return new Float32Array(input);
  const frame = Math.round(sampleRate * 0.04); // 40 ms windows
  const hopOut = Math.round(frame / 2);
  const hopIn = hopOut * rate;
  const tolerance = Math.round(sampleRate * 0.01); // search +-10 ms for the best overlap
  const outLen = Math.max(1, Math.floor(input.length / rate));
  const out = new Float32Array(outLen + frame);
  const norm = new Float32Array(outLen + frame);
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frame - 1));
  let prevEnd = 0; // input position following the last copied frame (natural continuation)
  for (let o = 0, k = 0; o < outLen; o += hopOut, k++) {
    const nominal = Math.round(k * hopIn);
    let best = nominal;
    if (k > 0) {
      let bestScore = -Infinity;
      const ref = prevEnd;
      for (let d = -tolerance; d <= tolerance; d += 4) {
        const cand = nominal + d;
        if (cand < 0 || cand + hopOut >= input.length || ref + hopOut >= input.length) continue;
        let s = 0;
        for (let i = 0; i < hopOut; i += 2) s += input[cand + i]! * input[ref + i]!;
        if (s > bestScore) { bestScore = s; best = cand; }
      }
    }
    for (let i = 0; i < frame && best + i < input.length && o + i < out.length; i++) {
      out[o + i]! += input[best + i]! * win[i]!;
      norm[o + i]! += win[i]!;
    }
    prevEnd = best + hopOut;
  }
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = norm[i]! > 1e-3 ? out[i]! / norm[i]! : 0;
  return res;
}
