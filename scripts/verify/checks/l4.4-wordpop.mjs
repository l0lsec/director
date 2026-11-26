import { assert } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';

// Render a word-pop caption and find which word carries the highlight color one frame before and after
// each word's start: it must switch exactly at the word boundary (within one frame).
export default async function () {
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    const r = await win.evaluate(async () => {
      const { lib } = globalThis.__directorMedia;
      const words = [{ text: 'ONE', start: 0, end: 400_000 }, { text: 'TWO', start: 433_333, end: 800_000 }, { text: 'THREE', start: 866_666, end: 1_300_000 }, { text: 'FOUR', start: 1_333_333, end: 1_800_000 }];
      const spec = { content: words.map((w) => w.text).join(' '), styleId: 'word-pop', font: 'Inter', size: 90, weight: 900, color: '#ffffff', highlightColor: '#ffff00', align: 'center', lineHeight: 1.05, maxWidth: 0.95, words };
      const tr = new lib.TextRenderer();
      const W = 1080, H = 400;
      // Bounding box of highlight-colored pixels at time t.
      const box = (t) => {
        const cv = tr.render('c', spec, t, 1_900_000, W, H, 1);
        const img = cv.getContext('2d').getImageData(0, 0, W, H).data;
        let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
        for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 4; if (img[i] > 200 && img[i + 1] > 200 && img[i + 2] < 60 && img[i + 3] > 200) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
        return x1 < 0 ? null : { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
      };
      // Reference: where each word's highlight sits mid-word (layout-independent, handles wrapping).
      const refs = words.map((w) => box((w.start + w.end) / 2));
      const activeAt = (t) => {
        const b = box(t);
        if (!b) return -1;
        let best = -1, bd = Infinity;
        refs.forEach((r, k) => { if (!r) return; const d = Math.hypot(r.cx - b.cx, r.cy - b.cy); if (d < bd) { bd = d; best = k; } });
        return bd < 20 ? best : -2;
      };
      const frame = 1_000_000 / 30;
      const out = [];
      for (let k = 1; k < words.length; k++) out.push({ k, before: activeAt(words[k].start - frame), after: activeAt(words[k].start + 1) });
      out.push({ k: 0, before: -9, after: activeAt(1) });
      return out;
    });
    const bad = r.filter((x) => x.after !== x.k || (x.k > 0 && x.before !== x.k - 1));
    assert(bad.length === 0, `highlight did not switch at word boundaries: ${JSON.stringify(r)}`);
    return 'highlight is on word k from its start time and on word k-1 one frame earlier, for every word';
  } finally { await app.close(); }
}
