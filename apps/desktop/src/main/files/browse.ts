// Folder browsing for the Files panel: list a folder, search below it, make thumbnails and watch for changes.
// No Electron imports, so it runs (and is tested) under plain Node.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileKindOf, naturalCompare, type FileKind } from '@director/engine';

export interface FileEntry {
  name: string;
  path: string;
  /** Path below the opened folder, with "/" separators. */
  rel: string;
  type: 'dir' | FileKind;
  size: number;
  mtimeMs: number;
}
export interface Listing { dir: string; entries: FileEntry[]; skipped: number }

export class BrowseError extends Error {
  code: 'NOT_ABSOLUTE' | 'OUTSIDE_ROOTS' | 'NOT_FOUND' | 'NOT_A_FOLDER';
  constructor(code: BrowseError['code'], message: string) { super(message); this.code = code; }
}

// Folders that are really documents (app bundles, editor projects, photo libraries): shown as nothing, never entered.
const PACKAGE_EXTS = new Set(['.app', '.director', '.fcpbundle', '.photoslibrary', '.imovielibrary', '.tvlibrary', '.musiclibrary', '.logicx', '.band', '.prproj', '.drp', '.lrlibrary', '.bundle', '.framework', '.pkg', '.xcodeproj']);
const SKIP_DIRS = new Set(['node_modules', '$RECYCLE.BIN', 'System Volume Information']);

const real = (p: string) => { try { return realpathSync(p); } catch { return null; } };
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** The opened folder that contains p (both resolved through symlinks), or an error naming why p is not allowed. */
export function rootFor(p: string, roots: string[]): string {
  if (!isAbsolute(p)) throw new BrowseError('NOT_ABSOLUTE', `Not an absolute path: ${p}`);
  const rp = real(p);
  if (!rp) throw new BrowseError('NOT_FOUND', `${p} does not exist`);
  for (const r of roots) { const rr = real(r); if (rr && within(rp, rr)) return r; }
  throw new BrowseError('OUTSIDE_ROOTS', `${p} is not inside a folder opened in the Files panel`);
}

function entry(root: string, dir: string, name: string): FileEntry | null {
  if (name.startsWith('.') || SKIP_DIRS.has(name)) return null;
  const path = join(dir, name);
  let st;
  try { st = statSync(path); } catch { return null; }
  const rel = relative(root, path).split(sep).join('/');
  if (st.isDirectory()) {
    if (PACKAGE_EXTS.has(extname(name).toLowerCase())) return null;
    return { name, path, rel, type: 'dir', size: 0, mtimeMs: st.mtimeMs };
  }
  const kind = st.isFile() ? fileKindOf(name) : null;
  return kind ? { name, path, rel, type: kind, size: st.size, mtimeMs: st.mtimeMs } : null;
}

const order = (a: FileEntry, b: FileEntry) => (a.type === 'dir') === (b.type === 'dir') ? naturalCompare(a.name, b.name) : a.type === 'dir' ? -1 : 1;

/** One folder's subfolders and media files (folders first, Finder order). skipped counts other files left out. */
export function listDir(dir: string, roots: string[]): Listing {
  const root = rootFor(dir, roots);
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) throw new BrowseError('NOT_A_FOLDER', `${dir} is a file, not a folder`);
    names = readdirSync(dir);
  } catch (e) { if (e instanceof BrowseError) throw e; throw new BrowseError('NOT_FOUND', `Cannot read ${dir}`); }
  const entries: FileEntry[] = [];
  let skipped = 0;
  for (const n of names) { const e = entry(root, dir, n); if (e) entries.push(e); else if (!n.startsWith('.')) skipped++; }
  return { dir, entries: entries.sort(order), skipped };
}

export interface SearchOptions { kinds?: FileKind[]; limit?: number; maxDirs?: number }
export interface SearchResult { results: FileEntry[]; truncated: boolean; dirsScanned: number }

/**
 * Media files below dir whose path (relative to the opened folder) contains every word of q, nearest folders first.
 * Bounded by limit results and maxDirs folders; symlink loops are visited once.
 */
export function searchFiles(dir: string, q: string, roots: string[], opts: SearchOptions = {}): SearchResult {
  const root = rootFor(dir, roots);
  const limit = opts.limit ?? 300, maxDirs = opts.maxDirs ?? 5000;
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const kinds = opts.kinds?.length ? new Set(opts.kinds) : null;
  const results: FileEntry[] = [];
  const seen = new Set<string>();
  const queue = [dir];
  let dirsScanned = 0, truncated = false;
  while (queue.length) {
    const d = queue.shift()!;
    const rd = real(d);
    if (!rd || seen.has(rd)) continue;
    seen.add(rd);
    if (++dirsScanned > maxDirs) { truncated = true; break; }
    let names: string[];
    try { names = readdirSync(d); } catch { continue; }
    const here: FileEntry[] = [];
    for (const n of names) {
      const e = entry(root, d, n);
      if (!e) continue;
      if (e.type === 'dir') { queue.push(e.path); continue; }
      if (kinds && !kinds.has(e.type)) continue;
      const hay = e.rel.toLowerCase();
      if (terms.every((t) => hay.includes(t))) here.push(e);
    }
    for (const e of here.sort(order)) { if (results.length >= limit) { truncated = true; break; } results.push(e); }
    if (truncated) break;
  }
  return { results, truncated, dirsScanned };
}

// Thumbnails: one small JPEG per file version, made at most three at a time.
let running = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= 3) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}
const run = (cmd: string, args: string[]) => new Promise<void>((res, rej) => execFile(cmd, args, { timeout: 20_000 }, (err) => (err ? rej(err) : res())));
const inflight = new Map<string, Promise<string | null>>();

/** A cached JPEG thumbnail for a video or image (240 px wide), or null when none can be made. Audio has none. */
export function thumbnail(path: string, cacheDir: string, ffmpeg: string | null): Promise<string | null> {
  const kind = fileKindOf(basename(path));
  if (kind !== 'video' && kind !== 'image') return Promise.resolve(null);
  let st;
  try { st = statSync(path); } catch { return Promise.resolve(null); }
  const key = createHash('sha1').update(`${path}\0${st.size}\0${st.mtimeMs}`).digest('hex');
  const out = join(cacheDir, `${key}.jpg`);
  if (existsSync(out)) return Promise.resolve(out);
  const pending = inflight.get(out);
  if (pending) return pending;
  const p = slot(async () => {
    mkdirSync(cacheDir, { recursive: true });
    try {
      if (kind === 'image') await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '240', path, '--out', out]);
      else if (ffmpeg) {
        // A frame one second in shows the shot better than a black first frame; very short clips fall back to the start.
        try { await run(ffmpeg, ['-v', 'error', '-ss', '1', '-i', path, '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '5', '-y', out]); } catch { /* retried below */ }
        if (!existsSync(out)) await run(ffmpeg, ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', 'scale=240:-2', '-q:v', '5', '-y', out]);
      }
    } catch { /* unreadable or unsupported: no thumbnail */ }
    return existsSync(out) ? out : null;
  }).finally(() => inflight.delete(out));
  inflight.set(out, p);
  return p;
}

/**
 * Watch an opened folder (recursively) and report which folders changed, at most every `debounceMs`.
 * Returns a function that stops watching.
 */
export function watchRoot(root: string, onChange: (dirs: string[]) => void, debounceMs = 250): () => void {
  let w: FSWatcher;
  const dirs = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  try {
    w = watch(root, { recursive: true }, (_ev, file) => {
      if (!file) { dirs.add(root); }
      else {
        const name = String(file);
        if (name.split(sep).some((s) => s.startsWith('.'))) return;
        dirs.add(dirname(join(root, name)));
      }
      timer ??= setTimeout(() => { timer = null; const list = [...dirs]; dirs.clear(); onChange(list); }, debounceMs);
    });
  } catch { return () => {}; }
  w.on('error', () => {});
  return () => { if (timer) clearTimeout(timer); w.close(); };
}
