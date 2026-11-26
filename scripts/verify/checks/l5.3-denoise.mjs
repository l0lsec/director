import { assert, fixture, tmp } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';
import { readFileSync } from 'node:fs';

function readWav(p) {
  const b = readFileSync(p); let o = 12;
  while (o < b.length) { const id = b.toString('latin1', o, o + 4), sz = b.readUInt32LE(o + 4); if (id === 'data') { const n = Math.floor(sz / 2); const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = b.readInt16LE(o + 8 + i * 2) / 32768; return a; } o += 8 + sz + (sz & 1); }
  throw new Error('no data');
}

// SNR = speech power where the clean reference is voiced over residual power where it is silent.
export default async function () {
  const clean = readWav(fixture('clean-speech.wav'));
  const env = new Float32Array(clean.length); let e = 0; for (let i = 0; i < clean.length; i++) { e = Math.max(Math.abs(clean[i]), e * 0.999); env[i] = e; }
  const snr = (x) => { let ps = 0, ns = 0, pn = 0, nn = 0; for (let i = 0; i < clean.length && i < x.length; i++) { if (env[i] > 0.05) { ps += x[i] ** 2; ns++; } else if (env[i] < 1e-4) { pn += x[i] ** 2; nn++; } } return 10 * Math.log10((ps / ns) / (pn / nn)); };
  const { app, win } = await launchEditor();
  try {
    const out = await win.evaluate(async (p) => (await window.director.invoke('audio:process', { path: p, denoise: true })).value.path, fixture('noisy-speech.wav'));
    const before = snr(readWav(fixture('noisy-speech.wav')));
    const after = snr(readWav(out));
    const detail = `SNR ${before.toFixed(1)} dB -> ${after.toFixed(1)} dB (+${(after - before).toFixed(1)} dB)`;
    assert(after - before >= 10, detail);
    void tmp;
    return detail;
  } finally { await app.close(); }
}
