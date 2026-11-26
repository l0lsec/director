import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import type { MediaRef } from '@director/engine';
import { importOne, expandPaths, findByHash, cacheDirFor, makeProxy, quickHash } from './importer';
import { probeMedia } from '../jobs/probe';

export function mediaCacheRoot(projectDir?: string | null): string {
  const d = projectDir ? join(projectDir, 'cache', 'media') : join(process.env.DIRECTOR_USER_DATA ?? app.getPath('userData'), 'cache', 'media');
  mkdirSync(d, { recursive: true });
  return d;
}

export const mediaHandlers = {
  'media:import': async (i: { paths: string[]; projectDir?: string; proxies?: boolean; role?: MediaRef['role'] }) => {
    const files = expandPaths(i.paths);
    const out = [];
    for (const f of files) {
      try { out.push({ ok: true as const, ...(await importOne(f, mediaCacheRoot(i.projectDir), { proxies: i.proxies, role: i.role })) }); }
      catch (err) { out.push({ ok: false as const, path: f, error: (err as Error).message }); }
    }
    return out;
  },
  'media:derived': (i: { hash: string; projectDir?: string }) => {
    const dir = cacheDirFor(mediaCacheRoot(i.projectDir), i.hash);
    const thumbs = join(dir, 'thumbs.jpg');
    const peaks = join(dir, 'peaks.u8');
    const proxy = join(dir, 'proxy.mp4');
    return { thumbs: existsSync(thumbs) ? thumbs : null, peaks: existsSync(peaks) ? peaks : null, proxy: existsSync(proxy) ? proxy : null };
  },
  'media:peaks': (i: { path: string }) => new Uint8Array(readFileSync(i.path)),
  'media:check': (i: { paths: string[] }) => i.paths.map((p) => ({ path: p, exists: existsSync(p) })),
  'media:relink': (i: { hash: string; size?: number; dirs: string[] }) => findByHash(i.hash, i.size ?? null, i.dirs),
  'media:proxy': async (i: { path: string; projectDir?: string }) => {
    const p = await probeMedia(i.path);
    return makeProxy(i.path, p, cacheDirFor(mediaCacheRoot(i.projectDir), quickHash(i.path)));
  },
  'media:size': (i: { path: string }) => (existsSync(i.path) ? statSync(i.path).size : null),
};
