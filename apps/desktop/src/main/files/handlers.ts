import { app, BrowserWindow } from 'electron';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { FileKind } from '@director/engine';
import { getSetting, setSetting } from '../settings';
import { resolveSidecar } from '../jobs/sidecars';
import { listDir, searchFiles, thumbnail, watchRoot, rootFor, BrowseError } from './browse';

/** Folders the person opened in the Files panel; browsing (theirs and agents') is limited to these. */
export interface FileRoots { roots: string[]; current: string | null }

const MAX_ROOTS = 12;
const broadcast = (event: string, payload: unknown) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`director:event:${event}`, payload); };
const watchers = new Map<string, () => void>();

function state(): FileRoots {
  const roots = getSetting<string[]>('files.roots', []).filter((r) => { try { return statSync(r).isDirectory(); } catch { return false; } });
  const cur = getSetting<string | null>('files.current', null);
  return { roots, current: cur && roots.includes(cur) ? cur : roots[0] ?? null };
}

function syncWatchers(roots: string[]): void {
  for (const [r, stop] of watchers) if (!roots.includes(r)) { stop(); watchers.delete(r); }
  for (const r of roots) if (!watchers.has(r)) watchers.set(r, watchRoot(r, (dirs) => broadcast('files:changed', { root: r, dirs })));
}

const cacheDir = () => join(process.env.DIRECTOR_USER_DATA ?? app.getPath('userData'), 'cache', 'browse');
const errs = <T>(fn: () => T): T => {
  try { return fn(); } catch (e) { if (e instanceof BrowseError) throw Object.assign(new Error(e.message), { code: e.code }); throw e; }
};

export const filesHandlers = {
  'files:roots': (): FileRoots => { const s = state(); syncWatchers(s.roots); return s; },
  'files:addRoot': ({ path }: { path: string }): FileRoots => {
    const p = resolve(path);
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch { /* missing */ }
    if (!isDir) throw Object.assign(new Error(`${path} is not a folder`), { code: 'NOT_A_FOLDER' });
    const roots = [p, ...state().roots.filter((r) => r !== p)].slice(0, MAX_ROOTS);
    setSetting('files.roots', roots);
    setSetting('files.current', p);
    syncWatchers(roots);
    return state();
  },
  'files:removeRoot': ({ path }: { path: string }): FileRoots => {
    const s = state();
    setSetting('files.roots', s.roots.filter((r) => r !== path));
    if (s.current === path) setSetting('files.current', null);
    const next = state();
    syncWatchers(next.roots);
    return next;
  },
  'files:setCurrent': ({ path }: { path: string }): FileRoots => {
    if (!state().roots.includes(path)) throw Object.assign(new Error(`${path} is not an opened folder`), { code: 'OUTSIDE_ROOTS' });
    setSetting('files.current', path);
    return state();
  },
  'files:list': ({ dir }: { dir: string }) => errs(() => listDir(dir, state().roots)),
  'files:search': ({ dir, q, kinds, limit }: { dir: string; q: string; kinds?: FileKind[]; limit?: number }) => errs(() => searchFiles(dir, q, state().roots, { kinds, limit })),
  'files:thumb': ({ path }: { path: string }) => { errs(() => rootFor(path, state().roots)); return thumbnail(path, cacheDir(), resolveSidecar('ffmpeg')); },
};

export function stopFileWatchers(): void { for (const stop of watchers.values()) stop(); watchers.clear(); }
