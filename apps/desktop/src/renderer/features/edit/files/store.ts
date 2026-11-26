import { create } from 'zustand';
import type { FileKind } from '@director/engine';
import { invoke, onEvent } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';

export interface FileEntry { name: string; path: string; rel: string; type: 'dir' | FileKind; size: number; mtimeMs: number }
export interface Listing { dir: string; entries: FileEntry[]; skipped: number }
export type KindFilter = 'all' | FileKind;
export interface Row { entry: FileEntry; depth: number }

interface FilesState {
  ready: boolean;
  roots: string[];
  current: string | null;
  listings: Record<string, Listing>;
  expanded: Record<string, boolean>;
  selected: string[];
  anchor: string | null;
  focus: string | null;
  query: string;
  kind: KindFilter;
  search: { q: string; results: FileEntry[]; truncated: boolean } | null;
  searching: boolean;
  error: string | null;
}

export const useFiles = create<FilesState>(() => ({
  ready: false, roots: [], current: null, listings: {}, expanded: {}, selected: [], anchor: null, focus: null,
  query: '', kind: 'all', search: null, searching: false, error: null,
}));
const set = useFiles.setState;
const get = useFiles.getState;
const toast = (m: string, k: 'info' | 'ok' | 'error' = 'info') => useShell.getState().toast(m, k);
const errMsg = (e: unknown) => (e as Error)?.message ?? String(e);

export async function loadDir(dir: string): Promise<Listing | null> {
  try {
    const l = await invoke('files:list', { dir });
    set((s) => ({ listings: { ...s.listings, [dir]: l }, error: s.current === dir ? null : s.error }));
    return l;
  } catch (e) {
    if (dir === get().current) set({ error: errMsg(e) });
    return null;
  }
}

let unsub: (() => void) | null = null;
/** Load the opened folders (once) and keep listings fresh as files change on disk. */
export async function initFiles(): Promise<void> {
  if (!unsub) {
    unsub = onEvent('files:changed', ({ root, dirs }) => {
      const s = get();
      if (root !== s.current) return;
      for (const d of dirs) if (s.listings[d]) void loadDir(d);
      if (s.search) void runSearch(s.search.q);
    });
  }
  const r = await invoke('files:roots', {});
  set({ roots: r.roots, current: r.current, ready: true });
  if (r.current && !get().listings[r.current]) await loadDir(r.current);
}

function resetView(current: string | null) {
  set({ current, listings: {}, expanded: {}, selected: [], anchor: null, focus: null, query: '', search: null, error: null });
}

/** Ask for a folder and open it (it is remembered across launches). */
export async function openFolder(): Promise<void> {
  const picked = await invoke('dialog:open', { title: 'Open a folder of media', directory: true });
  if (!picked.length) return;
  await addRoot(picked[0]!);
}
export async function addRoot(path: string): Promise<void> {
  try {
    const r = await invoke('files:addRoot', { path });
    resetView(r.current);
    set({ roots: r.roots });
    if (r.current) await loadDir(r.current);
  } catch (e) { toast(errMsg(e), 'error'); }
}
export async function switchRoot(path: string): Promise<void> {
  const r = await invoke('files:setCurrent', { path });
  resetView(r.current);
  set({ roots: r.roots });
  if (r.current) await loadDir(r.current);
}
export async function removeRoot(path: string): Promise<void> {
  const r = await invoke('files:removeRoot', { path });
  resetView(r.current);
  set({ roots: r.roots });
  if (r.current) await loadDir(r.current);
}

export async function toggleDir(dir: string, open?: boolean): Promise<void> {
  const next = open ?? !get().expanded[dir];
  set((s) => ({ expanded: { ...s.expanded, [dir]: next } }));
  if (next && !get().listings[dir]) await loadDir(dir);
}

/** Reveal a file in the tree: open every folder between the root and it. */
export async function revealInTree(path: string): Promise<void> {
  const root = get().current;
  if (!root || !path.startsWith(root + '/')) return;
  const parts = path.slice(root.length + 1).split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) { dir = `${dir}/${p}`; await toggleDir(dir, true); }
  set({ selected: [path], anchor: path, focus: path, query: '', search: null });
}

export async function refreshAll(): Promise<void> {
  const s = get();
  await Promise.all(Object.keys(s.listings).map((d) => loadDir(d)));
  if (s.search) await runSearch(s.search.q);
}

let searchSeq = 0;
export async function runSearch(q: string): Promise<void> {
  const s = get();
  if (!s.current || !q.trim()) { set({ search: null, searching: false }); return; }
  const seq = ++searchSeq;
  set({ searching: true });
  try {
    const r = await invoke('files:search', { dir: s.current, q, kinds: s.kind === 'all' ? undefined : [s.kind], limit: 300 });
    if (seq === searchSeq) set({ search: { q, results: r.results, truncated: r.truncated }, searching: false });
  } catch (e) { if (seq === searchSeq) set({ searching: false, error: errMsg(e) }); }
}
let timer: ReturnType<typeof setTimeout> | null = null;
export function setQuery(q: string): void {
  set({ query: q });
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void runSearch(q), 180);
}
export function setKind(kind: KindFilter): void {
  set({ kind });
  const q = get().query;
  if (q.trim()) void runSearch(q);
}

/** The rows on screen: search results when searching, otherwise the open folders of the tree. */
export function visibleRows(s: Pick<FilesState, 'current' | 'listings' | 'expanded' | 'kind' | 'search'>): Row[] {
  const keep = (e: FileEntry) => e.type === 'dir' || s.kind === 'all' || e.type === s.kind;
  if (s.search) return s.search.results.filter(keep).map((entry) => ({ entry, depth: 0 }));
  const out: Row[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of s.listings[dir]?.entries ?? []) {
      if (!keep(e)) continue;
      out.push({ entry: e, depth });
      if (e.type === 'dir' && s.expanded[e.path]) walk(e.path, depth + 1);
    }
  };
  if (s.current) walk(s.current, 0);
  return out;
}

/** Click selection: plain click picks one, Cmd toggles, Shift extends over the visible rows. */
export function selectRow(path: string, rows: Row[], mods: { meta?: boolean; shift?: boolean } = {}): void {
  const s = get();
  if (mods.shift && s.anchor) {
    const a = rows.findIndex((r) => r.entry.path === s.anchor), b = rows.findIndex((r) => r.entry.path === path);
    if (a >= 0 && b >= 0) { set({ selected: rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((r) => r.entry.path), focus: path }); return; }
  }
  if (mods.meta) { set({ selected: s.selected.includes(path) ? s.selected.filter((p) => p !== path) : [...s.selected, path], anchor: path, focus: path }); return; }
  set({ selected: [path], anchor: path, focus: path });
}

export function entryFor(path: string): FileEntry | null {
  const s = get();
  for (const l of Object.values(s.listings)) { const e = l.entries.find((x) => x.path === path); if (e) return e; }
  return s.search?.results.find((x) => x.path === path) ?? null;
}
