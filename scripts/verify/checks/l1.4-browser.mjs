import { assert } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet } from '../capture-lib.mjs';

export default async function () {
  const { app, win } = await launchWithFakeDevices();
  try {
    await recordFor(win, 2000);
    await stopAndGet(win);
    const r = await win.evaluate(async () => {
      const R = globalThis.__directorRecord;
      const first = R.get().takes[0];
      await R.rateTake(first, 4);
      await R.renameTake(R.get().takes[0], 'Renamed take');
      const afterEdit = R.get().takes[0];
      await R.trashTake(afterEdit);
      const afterTrash = R.get().takes.length;
      const all = (await window.director.invoke('take:list', { includeTrashed: true })).value;
      const trashed = all.find((t) => t.take.id === afterEdit.take.id);
      await R.restoreTake(trashed);
      return { rating: afterEdit.take.rating, title: afterEdit.take.title, afterTrash, trashedStatus: trashed.take.status, restored: R.get().takes.length, uiRows: document.querySelectorAll('[data-take]').length };
    });
    assert(r.rating === 4 && r.title === 'Renamed take', `rate/rename ${JSON.stringify(r)}`);
    assert(r.afterTrash === 0 && r.trashedStatus === 'trashed', 'trashed take hidden but kept on disk');
    assert(r.restored === 1, 'restored');
    return JSON.stringify(r);
  } finally { await app.close(); }
}
