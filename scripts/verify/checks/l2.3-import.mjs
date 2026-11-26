import { assert, fixture, groundTruth } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';

// Drag and drop and the Import dialog both go through the real importer; only the OS pieces are stubbed
// (the dropped File's path, and Electron's native open dialog in the main process).
export default async function () {
  const gt = groundTruth();
  const names = Object.keys(gt.checksums).filter((n) => !n.startsWith('clean-'));
  const half = Math.ceil(names.length / 2);
  const dropNames = names.slice(0, half);
  const dialogNames = names.slice(half);
  const { app, win } = await launchEditor();
  try {
    // 1. Drop onto the library.
    await win.evaluate(({ paths }) => {
      const map = new Map(paths.map((p) => [p.split('/').pop(), p]));
      globalThis.__directorPathForFile = (f) => map.get(f.name) ?? '';
      const dt = new DataTransfer();
      for (const p of paths) dt.items.add(new File([new Uint8Array(4)], p.split('/').pop()));
      const lib = document.querySelector('[data-testid="library"]');
      lib.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      lib.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, { paths: dropNames.map((n) => fixture(n)) });
    await win.waitForFunction((n) => Object.keys(globalThis.__directorProject().doc.media).length >= n, dropNames.length, { timeout: 120_000 });
    // 2. Import button with the native dialog stubbed in main.
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }); }, dialogNames.map((n) => fixture(n)));
    await win.click('[data-testid="import-button"]');
    await win.waitForFunction((n) => Object.keys(globalThis.__directorProject().doc.media).length >= n, names.length, { timeout: 180_000 });
    const media = await win.evaluate(() => Object.values(globalThis.__directorProject().doc.media));
    const derived = await win.evaluate(async (list) => Promise.all(list.map(async (m) => ({ name: m.name, kind: m.kind, d: (await window.director.invoke('media:derived', { hash: m.hash, projectDir: globalThis.__directorProject().dir })).value }))), media);
    const problems = [];
    for (const x of derived) {
      if (x.kind !== 'audio' && !x.d.thumbs) problems.push(`${x.name}: no thumbnail/filmstrip`);
      if (x.kind !== 'image' && x.name !== 'cuts-720p.mp4' && x.name !== 'hevc-4k.mp4' && !x.d.peaks) problems.push(`${x.name}: no waveform`);
    }
    for (const n of names) if (!media.some((m) => m.name === n)) problems.push(`${n} missing from the bin`);
    assert(problems.length === 0, problems.join('\n'));
    const tiles = await win.evaluate(() => document.querySelectorAll('[data-media]').length);
    assert(tiles === names.length, `library shows ${tiles} items`);
    return `${dropNames.length} dropped + ${dialogNames.length} via Import: all probed, with filmstrips and waveforms`;
  } finally { await app.close(); }
}
