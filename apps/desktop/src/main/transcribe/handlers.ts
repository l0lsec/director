import { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { transcribeFile } from './transcribe';
import { listModels, MODELS, modelDirs, remoteSha256, downloadVerified } from './models';

const downloads = new Map<string, AbortController>();
const broadcast = (event: string, payload: unknown) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`director:event:${event}`, payload); };

export const transcribeHandlers = {
  'transcribe:run': (i: { path: string; model?: string; language?: string; projectDir?: string; force?: boolean }) => transcribeFile(i.path, i),
  'models:list': () => listModels(),
  'models:download': async (i: { id: string; url?: string; sha256?: string }) => {
    const info = MODELS.find((m) => m.id === i.id);
    if (!info) throw Object.assign(new Error(`unknown model ${i.id}`), { code: 'NOT_FOUND' });
    const ac = new AbortController();
    downloads.set(i.id, ac);
    try {
      const sha = i.sha256 ?? (await remoteSha256(info));
      const dest = join(modelDirs()[0]!, info.file);
      return await downloadVerified(i.url ?? info.url, dest, sha, (got, total) => broadcast('models:progress', { id: i.id, got, total }), ac.signal);
    } finally { downloads.delete(i.id); }
  },
  'models:cancel': (i: { id: string }) => { downloads.get(i.id)?.abort(); return true; },
};
