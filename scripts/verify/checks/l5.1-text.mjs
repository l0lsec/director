import { assert, tmp, root } from '../lib.mjs';
import { launchEditor, RENDER_SNIPPET } from '../edit-lib.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const GOLD = join(root, 'fixtures', 'golden');
const gray = (png, w, h) => execFileSync('ffmpeg', ['-v', 'error', '-i', png, '-vf', `scale=${w}:${h},format=gray`, '-f', 'rawvideo', '-']);
function ssim(a, b, W, H) {
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2; let total = 0, n = 0;
  for (let y = 0; y + 8 <= H; y += 4) for (let x = 0; x + 8 <= W; x += 4) {
    let ma = 0, mb = 0; for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * W + x + i; ma += a[k]; mb += b[k]; }
    ma /= 64; mb /= 64; let va = 0, vb = 0, cv = 0;
    for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) { const k = (y + j) * W + x + i; va += (a[k] - ma) ** 2; vb += (b[k] - mb) ** 2; cv += (a[k] - ma) * (b[k] - mb); }
    total += ((2 * ma * mb + C1) * (2 * cv / 63 + C2)) / ((ma * ma + mb * mb + C1) * ((va + vb) / 63 + C2)); n++;
  }
  return total / n;
}

const CASES = [
  { name: 'title-steady', t: 1_500_000, text: { content: 'STOP TYPING PLAIN PROMPTS', size: 120, weight: 900, color: '#ffffff', stroke: { color: '#000000', width: 10 }, uppercase: true } },
  { name: 'title-pop-in', t: 120_000, text: { content: 'BIG IDEA', size: 140, weight: 900, color: '#ffffff', stroke: { color: '#000000', width: 10 }, animationIn: 'pop', animationDuration: 300_000 } },
  { name: 'lower-third-slide', t: 150_000, text: { content: 'Alex, founder', size: 54, weight: 700, color: '#ffffff', box: { color: 'rgba(0,0,0,0.72)', padding: 20, radius: 12 }, maxWidth: 0.7, animationIn: 'slide-left', animationDuration: 400_000 } },
  { name: 'callout-box', t: 1_000_000, text: { content: 'Save this', size: 76, weight: 900, color: '#1a1405', box: { color: '#f5b83d', padding: 22, radius: 18 } } },
  { name: 'typewriter-half', t: 450_000, text: { content: 'Ask me questions first', size: 64, weight: 700, color: '#ffffff', animationIn: 'typewriter', animationDuration: 900_000 } },
  { name: 'fade-out', t: 2_850_000, text: { content: 'See you next time', size: 70, weight: 800, color: '#ffffff', shadow: { color: 'rgba(0,0,0,0.9)', blur: 10, x: 0, y: 2 }, animationOut: 'fade', animationDuration: 300_000 } },
];

export default async function () {
  const update = process.env.DIRECTOR_UPDATE_GOLDEN === '1';
  const dir = tmp('text-golden');
  mkdirSync(GOLD, { recursive: true });
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    await win.evaluate(RENDER_SNIPPET);
    const scores = [];
    for (const c of CASES) {
      const bytes = await win.evaluate(async ({ c }) => {
        const E = globalThis.__directorEngine;
        const base = globalThis.__directorProject().doc;
        const lane = base.lanes.find((l) => l.kind === 'titles').id;
        const clip = { ...E.newClip({ kind: 'text', start: 0, out: 3_000_000 }), id: 'T', text: { font: 'Inter', align: 'center', lineHeight: 1.05, maxWidth: 0.86, ...c.text } };
        const doc = globalThis.__directorAnalysisApply(base, [{ op: 'setCanvas', patch: { background: { kind: 'color', color: '#3a4a6a' } } }, { op: 'addClip', laneId: lane, clip }]);
        await globalThis.__renderAt(doc, c.t, 0.5, [[0.5, 0.5]]);
        const blob = await globalThis.__rcomp.canvas.convertToBlob({ type: 'image/png' });
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }, { c });
      const cand = join(dir, `${c.name}.png`);
      writeFileSync(cand, Buffer.from(bytes));
      const gold = join(GOLD, `text-${c.name}.png`);
      if (update || !existsSync(gold)) { writeFileSync(gold, Buffer.from(bytes)); scores.push(`${c.name}: golden written`); continue; }
      const s = ssim(gray(cand, 480, 270), gray(gold, 480, 270), 480, 270);
      scores.push(`${c.name} ${s.toFixed(4)}`);
      assert(s >= 0.99, `${c.name} differs from its golden frame: SSIM ${s.toFixed(4)}`);
    }
    assert(!scores.some((s) => s.includes('written')) || update, `golden frames were missing and have been written; review fixtures/golden and rerun: ${scores.join(', ')}`);
    return `text styles and animations vs golden frames: ${scores.join(', ')}`;
  } finally { await app.close(); }
}
