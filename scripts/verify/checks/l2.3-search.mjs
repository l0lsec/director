import { assert } from '../lib.mjs';
import { launchEditor, importFixtures } from '../edit-lib.mjs';

export default async function () {
  const { app, win } = await launchEditor();
  try {
    const ids = await importFixtures(win, ['sync-1080p30.mp4', 'vertical-1080x1920.mp4', 'still.png', 'speech.wav', 'tone-440.wav', 'cuts-720p.mp4']);
    await win.evaluate((ids) => {
      const tags = { 0: ['talking head'], 1: ['b-roll', 'vertical'], 3: ['voice'], 5: ['b-roll'] };
      globalThis.__directorProjectApply(Object.entries(tags).map(([i, t]) => ({ op: 'updateMedia', id: ids[i], patch: { tags: t } })), 'tags');
    }, ids);
    const r = await win.evaluate(() => {
      const all = Object.values(globalThis.__directorProject().doc.media);
      const f = globalThis.__directorLibrary.filterMedia;
      const names = (xs) => xs.map((m) => m.name).sort().join(',');
      return {
        video: names(f(all, { kind: 'video' })),
        audio: names(f(all, { kind: 'audio' })),
        image: names(f(all, { kind: 'image' })),
        broll: names(f(all, { tag: 'b-roll' })),
        long: names(f(all, { minDurUs: 9_000_000 })),
        q: names(f(all, { q: 'vert' })),
        qtag: names(f(all, { q: 'voice' })),
      };
    });
    const expect = {
      video: 'cuts-720p.mp4,sync-1080p30.mp4,vertical-1080x1920.mp4', audio: 'speech.wav,tone-440.wav', image: 'still.png',
      broll: 'cuts-720p.mp4,vertical-1080x1920.mp4', long: 'cuts-720p.mp4,speech.wav,sync-1080p30.mp4', q: 'vertical-1080x1920.mp4', qtag: 'speech.wav',
    };
    for (const k of Object.keys(expect)) assert(r[k] === expect[k], `${k}: got ${r[k]} want ${expect[k]}`);
    return 'type, tag, duration and text filters return exactly the expected sets';
  } finally { await app.close(); }
}
