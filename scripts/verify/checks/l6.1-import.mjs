import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { assert, vitest, fixture, tmp, ffprobe } from '../lib.mjs';
import { launchStudio, libCall, sha256, stage } from '../swipe-lib.mjs';

// Files and folders dropped on the Swipe workspace, then the same set again via the Import button.
// Each distinct content hash must be added exactly once; the expected set is computed here from the bytes.
export default async function () {
  const unit = vitest(['packages/library/test/library.test.ts'], { pattern: 'import', min: 3 });
  const dir = tmp('l6.1-import');
  const folder = join(dir, 'refs');
  const files = stage(folder, [
    [fixture('reference-reel.mp4'), 'reference-reel.mp4'],
    [fixture('cuts-720p.mp4'), 'cuts.mp4'],
    [fixture('vertical-1080x1920.mp4'), 'sub/vertical.mp4'],
    [fixture('reference-reel.mp4'), 'sub/reel copy.mov'],
  ]);
  writeFileSync(join(folder, 'notes.txt'), 'not a video');
  const single = fixture('sync-1080p30.mp4');
  const all = [...files, single];
  const distinct = new Set(all.map(sha256));
  assert(distinct.size === 4, `fixture setup: expected 4 distinct files, got ${distinct.size}`);
  const { app, win } = await launchStudio();
  try {
    await win.waitForSelector('[data-testid="swipe-workspace"]');
    const brandId = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    await win.evaluate(({ paths }) => {
      const map = new Map(paths.map((p) => [p.split('/').pop(), p]));
      globalThis.__directorPathForFile = (f) => map.get(f.name) ?? '';
      const dt = new DataTransfer();
      for (const p of paths) dt.items.add(new File([new Uint8Array(4)], p.split('/').pop()));
      const el = document.querySelector('[data-testid="swipe-workspace"]');
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { paths: [folder, single] });
    await win.waitForFunction(() => document.querySelectorAll('[data-testid="ref-grid"] [data-ref]').length >= 4, null, { timeout: 60_000 });
    // Same files again through the Import button (native dialog stubbed in main).
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, all);
    await win.click('[data-testid="import-files"]');
    await win.waitForFunction(() => [...document.querySelectorAll('.toast')].some((t) => /already in the library/.test(t.textContent)), null, { timeout: 60_000 });
    const refs = await libCall(win, 'swipe.list', brandId);
    assert(refs.length === distinct.size, `library has ${refs.length} references, expected ${distinct.size}`);
    assert(new Set(refs.map((r) => r.hash)).size === refs.length, 'duplicate hashes in the library');
    for (const h of distinct) assert(refs.some((r) => r.hash === h), `hash ${h.slice(0, 12)} missing`);
    const cards = await win.evaluate(() => document.querySelectorAll('[data-testid="ref-grid"] [data-ref]').length);
    assert(cards === distinct.size, `grid shows ${cards} cards`);
    for (const r of refs) {
      const p = ffprobe(r.path);
      const dur = Math.round(Number(p.format.duration) * 1e6);
      assert(Math.abs(r.durationUs - dur) < 50_000, `${r.title}: duration ${r.durationUs} vs ffprobe ${dur}`);
      const v = p.streams.find((s) => s.codec_type === 'video');
      assert(r.width === v.width && r.height === v.height, `${r.title}: size ${r.width}x${r.height}`);
    }
    return `${unit}; app: ${all.length} files plus a text file across a folder tree, imported twice, ${refs.length} references (one per content hash), sizes and durations match ffprobe`;
  } finally { await app.close(); }
}
