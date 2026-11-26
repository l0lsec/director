import { useEffect, useMemo, useRef, useState } from 'react';
import { LANE_LABEL, fileKindOf, type LaneKind } from '@director/engine';
import { mediaUrl } from '@director/media';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { openContextMenu, type MenuItem } from '../../../shell/ContextMenu';
import { useProject } from '../../project/store';
import { registerEditPanel } from '../panels';
import { setEdit } from '../store';
import { registerCommands } from '../../palette/registry';
import {
  useFiles, initFiles, openFolder, addRoot, switchRoot, removeRoot, toggleDir, refreshAll, setQuery, setKind, visibleRows, selectRow, entryFor, revealInTree,
  type FileEntry, type KindFilter, type Row,
} from './store';
import { placeFiles, importFiles, filesIn, lanesFor, defaultLane, type PickedFile, type Placement } from './actions';
import './files.css';

const folderName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const toPicked = (e: FileEntry): PickedFile => ({ path: e.path, rel: e.rel });
function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => useShell.getState().toast('Path copied', 'ok')).catch(() => useShell.getState().toast('Could not copy', 'error')); };

/** The selected files, or the one under the pointer when it is not part of the selection. */
function pickedFor(target: FileEntry): FileEntry[] {
  const s = useFiles.getState();
  const sel = s.selected.includes(target.path) ? s.selected.map(entryFor).filter((e): e is FileEntry => !!e) : [target];
  return sel.filter((e) => e.type !== 'dir');
}
const common = (files: FileEntry[]): LaneKind[] => {
  const sets = files.map((f) => lanesFor(f.path));
  return sets.length ? sets.reduce((a, b) => a.filter((k) => b.includes(k))) : [];
};

const add = (files: FileEntry[], placement: Placement = { mode: 'playhead' }, lane?: LaneKind) => void placeFiles(files.map(toPicked), { placement, lane });
const importOnly = (files: FileEntry[]) => void importFiles(files.map(toPicked));
async function addFolder(dir: string, mode: 'timeline' | 'import') {
  const files = await filesIn(dir);
  if (!files.length) { useShell.getState().toast('No media in that folder', 'info'); return; }
  if (mode === 'import') await importFiles(files);
  else await placeFiles(files, { placement: { mode: 'end' } });
}

function menuFor(target: FileEntry): MenuItem[] {
  if (target.type === 'dir') {
    const open = !!useFiles.getState().expanded[target.path];
    return [
      { id: 'toggle', label: open ? 'Collapse' : 'Expand', run: () => void toggleDir(target.path) },
      { separator: true },
      { id: 'folder-add', label: 'Add all to the timeline', hint: 'at the end of each lane', run: () => void addFolder(target.path, 'timeline') },
      { id: 'folder-import', label: 'Import all to Media', run: () => void addFolder(target.path, 'import') },
      { separator: true },
      { id: 'reveal', label: 'Reveal in Finder', run: () => void invoke('shell:reveal', { path: target.path }) },
      { id: 'copy', label: 'Copy path', run: () => copy(target.path) },
    ];
  }
  const files = pickedFor(target);
  const many = files.length > 1;
  const lanes = common(files);
  const suggested = many ? null : defaultLane(toPicked(files[0]!)).lane;
  return [
    { id: 'add', label: many ? `Add ${files.length} files at the playhead` : 'Add at the playhead', hint: 'Enter', run: () => add(files) },
    { id: 'add-end', label: 'Add to the end', hint: 'Shift+Enter', run: () => add(files, { mode: 'end' }) },
    { id: 'add-lane', label: 'Add to lane', disabled: !lanes.length, items: lanes.map((k) => ({ id: `lane-${k}`, label: LANE_LABEL[k], hint: k === suggested ? 'suggested' : undefined, run: () => add(files, { mode: 'playhead' }, k) })) },
    { separator: true },
    { id: 'import', label: many ? `Import ${files.length} files to Media` : 'Import to Media', run: () => importOnly(files) },
    { separator: true },
    { id: 'reveal', label: 'Reveal in Finder', disabled: many, run: () => void invoke('shell:reveal', { path: files[0]!.path }) },
    { id: 'copy', label: many ? 'Copy paths' : 'Copy path', run: () => copy(files.map((f) => f.path).join('\n')) },
  ];
}

const thumbs = new Map<string, string | null>();
let keyboardMove = false;
function Thumb({ e }: { e: FileEntry }) {
  const key = `${e.path}\0${e.mtimeMs}`;
  const [src, setSrc] = useState<string | null>(thumbs.get(key) ?? null);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (e.type !== 'video' && e.type !== 'image') return;
    if (thumbs.has(key)) { setSrc(thumbs.get(key)!); return; }
    const el = ref.current;
    if (!el) return;
    let live = true;
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((x) => x.isIntersecting)) return;
      io.disconnect();
      void invoke('files:thumb', { path: e.path }).then((p) => { const u = p ? mediaUrl(p) : null; thumbs.set(key, u); if (live) setSrc(u); }).catch(() => thumbs.set(key, null));
    });
    io.observe(el);
    return () => { live = false; io.disconnect(); };
  }, [key, e.type, e.path]);
  const glyph = e.type === 'dir' ? '' : e.type === 'audio' ? '♪' : '';
  return <span ref={ref} className={`fb-thumb ${e.type}`} style={src ? { backgroundImage: `url("${src}")` } : undefined} data-loaded={src ? '1' : undefined} aria-hidden="true">{!src && glyph}</span>;
}

function RowView({ row, rows, inProject, focused, selected, open }: { row: Row; rows: Row[]; inProject: boolean; focused: boolean; selected: boolean; open: boolean }) {
  const e = row.entry;
  const isDir = e.type === 'dir';
  const ref = useRef<HTMLDivElement>(null);
  // Focus follows the selection without moving the list under the pointer; keyboard moves scroll the row into view.
  useEffect(() => {
    if (!focused || !ref.current || !document.activeElement?.closest('.fb-tree')) return;
    ref.current.focus({ preventScroll: true });
    if (keyboardMove) { keyboardMove = false; ref.current.scrollIntoView({ block: 'nearest' }); }
  }, [focused]);
  const lane = !isDir ? defaultLane(toPicked(e)) : null;
  const searching = !!useFiles.getState().search;
  return (
    <div
      ref={ref}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-selected={selected}
      aria-expanded={isDir ? open : undefined}
      tabIndex={focused ? 0 : -1}
      className={`fb-row ${selected ? 'sel' : ''}`}
      style={{ paddingLeft: 6 + row.depth * 14 }}
      data-path={e.path}
      data-type={e.type}
      draggable={!isDir}
      title={e.rel}
      onFocus={() => { if (useFiles.getState().focus !== e.path) useFiles.setState({ focus: e.path }); }}
      onClick={(ev) => { selectRow(e.path, rows, { meta: ev.metaKey, shift: ev.shiftKey }); if (isDir && !ev.metaKey && !ev.shiftKey && ev.detail === 1 && (ev.target as HTMLElement).closest('.fb-chev')) void toggleDir(e.path); }}
      onDoubleClick={() => { if (isDir) void toggleDir(e.path); else add(pickedFor(e)); }}
      onContextMenu={(ev) => { ev.preventDefault(); if (!useFiles.getState().selected.includes(e.path)) selectRow(e.path, rows); openContextMenu(ev.clientX, ev.clientY, menuFor(e)); }}
      onDragStart={(ev) => {
        const files = pickedFor(e);
        if (!useFiles.getState().selected.includes(e.path)) selectRow(e.path, rows);
        ev.dataTransfer.setData('application/x-director-files', JSON.stringify(files.map(toPicked)));
        ev.dataTransfer.effectAllowed = 'copy';
      }}
    >
      <span className="fb-chev" aria-hidden="true">{isDir ? (open ? '▾' : '▸') : ''}</span>
      <Thumb e={e} />
      <span className="fb-name">
        {e.name}
        {searching && e.rel.includes('/') && <span className="fb-where">{e.rel.slice(0, e.rel.lastIndexOf('/'))}</span>}
      </span>
      {inProject && <span className="fb-in" title="Already in this project" aria-label="in project">✓</span>}
      {lane && <span className="fb-lane" style={{ background: `var(--lane-${lane.lane})` }} title={`Adds to ${LANE_LABEL[lane.lane]} (${lane.why})`} />}
      {!isDir && <span className="fb-size">{bytes(e.size)}</span>}
    </div>
  );
}

let previewEl: HTMLMediaElement | null = null;
function Preview({ entries }: { entries: FileEntry[] }) {
  const dirs = entries.filter((e) => e.type === 'dir');
  const files = entries.filter((e) => e.type !== 'dir');
  if (!entries.length) return <div className="fb-preview empty hint">Select a file to preview it. Double-click or press Enter to add it at the playhead; right-click for more.</div>;
  if (dirs.length === 1 && !files.length) {
    const d = dirs[0]!;
    return (
      <div className="fb-preview" data-testid="files-preview">
        <div className="fb-pv-name">{d.name}</div>
        <div className="row fb-pv-actions">
          <button className="mini primary" onClick={() => void addFolder(d.path, 'timeline')}>Add all to timeline</button>
          <button className="mini" onClick={() => void addFolder(d.path, 'import')}>Import all</button>
        </div>
      </div>
    );
  }
  const one = files.length === 1 ? files[0]! : null;
  const lane = one ? defaultLane(toPicked(one)) : null;
  const heic = one && /\.heic$/i.test(one.name);
  return (
    <div className="fb-preview" data-testid="files-preview">
      {one?.type === 'video' && <video key={one.path} ref={(el) => { previewEl = el; }} src={mediaUrl(one.path)} controls preload="metadata" playsInline data-testid="files-preview-media" />}
      {one?.type === 'audio' && <audio key={one.path} ref={(el) => { previewEl = el; }} src={mediaUrl(one.path)} controls preload="metadata" data-testid="files-preview-media" />}
      {one?.type === 'image' && (heic ? <Thumb e={one} /> : <img key={one.path} src={mediaUrl(one.path)} alt={one.name} data-testid="files-preview-media" />)}
      <div className="fb-pv-name">{one ? one.name : `${files.length} files selected`}</div>
      {one && <div className="hint">{bytes(one.size)} · modified {new Date(one.mtimeMs).toLocaleDateString()} · adds to <b>{LANE_LABEL[lane!.lane]}</b> ({lane!.why})</div>}
      <div className="row fb-pv-actions">
        <button className="mini primary" onClick={() => add(files)} data-testid="files-add">Add at playhead</button>
        <button className="mini" onClick={() => add(files, { mode: 'end' })}>Add to end</button>
        <button className="mini" onClick={() => importOnly(files)} data-testid="files-import">Import</button>
      </div>
    </div>
  );
}

/** Browse a content folder and put files on the timeline (or in the Media bin) without the Finder round trip. */
export function FilesPanel() {
  const s = useFiles();
  const doc = useProject((p) => p.doc);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => { void initFiles(); }, []);
  const rows = useMemo(() => visibleRows(s), [s.current, s.listings, s.expanded, s.kind, s.search]);
  const inProject = useMemo(() => new Set(Object.values(doc?.media ?? {}).map((m) => m.path)), [doc?.media]);
  const selectedEntries = s.selected.map(entryFor).filter((e): e is FileEntry => !!e);
  (globalThis as Record<string, unknown>).__directorFiles = { state: () => useFiles.getState(), rows: () => visibleRows(useFiles.getState()).map((r) => r.entry.rel), addRoot, revealInTree };

  const onKey = (ev: React.KeyboardEvent) => {
    const i = rows.findIndex((r) => r.entry.path === s.focus);
    const cur = rows[i]?.entry;
    const move = (j: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) { keyboardMove = true; selectRow(r.entry.path, rows, { shift: ev.shiftKey }); } };
    switch (ev.key) {
      case 'ArrowDown': move(i < 0 ? 0 : i + 1); break;
      case 'ArrowUp': move(i < 0 ? 0 : i - 1); break;
      case 'Home': move(0); break;
      case 'End': move(rows.length - 1); break;
      case 'ArrowRight':
        if (cur?.type === 'dir') { if (!s.expanded[cur.path]) void toggleDir(cur.path, true); else move(i + 1); }
        break;
      case 'ArrowLeft':
        if (cur?.type === 'dir' && s.expanded[cur.path]) void toggleDir(cur.path, false);
        else if (cur && !s.search) { const parent = cur.path.slice(0, cur.path.lastIndexOf('/')); if (parent !== s.current) { keyboardMove = true; selectRow(parent, rows); } }
        break;
      case 'Enter': {
        // The selected files when there are any (Cmd+A, Shift+arrows), otherwise the focused row.
        const files = s.selected.map(entryFor).filter((e): e is FileEntry => !!e && e.type !== 'dir');
        const at: Placement = ev.shiftKey ? { mode: 'end' } : { mode: 'playhead' };
        if (files.length && !(cur?.type === 'dir' && s.selected.length === 1)) add(files, at);
        else if (cur?.type === 'dir') void toggleDir(cur.path);
        else if (cur) add([cur], at);
        break;
      }
      case ' ':
        if (previewEl) { if (previewEl.paused) void previewEl.play().catch(() => {}); else previewEl.pause(); }
        break;
      case 'a':
        if (!ev.metaKey) return;
        { const all = rows.filter((r) => r.entry.type !== 'dir').map((r) => r.entry.path); useFiles.setState({ selected: all, focus: s.focus ?? all[0] ?? null }); }
        break;
      case 'F10':
      case 'ContextMenu': {
        if (ev.key === 'F10' && !ev.shiftKey) return;
        const el = (ev.target as HTMLElement).closest('[role="treeitem"]')?.getBoundingClientRect();
        if (cur && el) openContextMenu(el.left + 24, el.bottom, menuFor(cur));
        break;
      }
      case 'Escape':
        if (!s.query) return;
        setQuery('');
        break;
      default: return;
    }
    ev.preventDefault();
    ev.stopPropagation();
  };

  if (!s.ready) return <div className="files" data-testid="files-panel" />;
  if (!s.roots.length) {
    return (
      <div className="files" data-testid="files-panel">
        <div className="fb-empty">
          <p>Open the folder where you keep your footage, music, sound effects and images. Director remembers it, and new files show up as they land.</p>
          <button className="primary" onClick={() => void openFolder()} data-testid="files-open">Open folder</button>
        </div>
      </div>
    );
  }

  const rootListing = s.current ? s.listings[s.current] : undefined;
  const folderMenu = (ev: React.MouseEvent) => {
    const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu(r.left, r.bottom + 2, [
      { id: 'open-another', label: 'Open another folder', run: () => void openFolder() },
      { id: 'refresh', label: 'Refresh', run: () => void refreshAll() },
      ...(s.current ? [{ id: 'reveal-root', label: 'Reveal in Finder', run: () => void invoke('shell:reveal', { path: s.current! }) }, { separator: true } as MenuItem, { id: 'close-root', label: 'Close this folder', run: () => void removeRoot(s.current!) }] : []),
    ]);
  };

  return (
    <div className="files" data-testid="files-panel" onDragOver={(ev) => { if ([...ev.dataTransfer.types].includes('Files')) ev.preventDefault(); }}
      onDrop={(ev) => {
        // Dropping a folder from Finder opens it here.
        const lookup = ((globalThis as Record<string, unknown>).__directorPathForFile as ((f: File) => string) | undefined) ?? window.director.pathForFile;
        const p = [...ev.dataTransfer.files].map((f) => lookup(f)).find(Boolean);
        if (p && !fileKindOf(p.split('/').pop() ?? '')) { ev.preventDefault(); void addRoot(p); }
      }}>
      <div className="fb-bar">
        <select aria-label="Folder" value={s.current ?? ''} onChange={(ev) => { if (ev.target.value === '\0open') void openFolder(); else void switchRoot(ev.target.value); }} data-testid="files-root">
          {s.roots.map((r) => <option key={r} value={r} title={r}>{folderName(r)}</option>)}
          <option value={'\0open'}>Open folder...</option>
        </select>
        <button className="mini" aria-label="Folder actions" title="Folder actions" onClick={folderMenu} data-testid="files-menu">•••</button>
      </div>
      <div className="fb-bar">
        <input ref={search} type="search" placeholder={`Search ${s.current ? folderName(s.current) : ''}`} aria-label="Search files" value={s.query} onChange={(ev) => setQuery(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === 'ArrowDown') { ev.preventDefault(); const r = rows[0]; if (r) { selectRow(r.entry.path, rows); (document.querySelector('.fb-tree [tabindex="0"]') as HTMLElement | null)?.focus(); } } if (ev.key === 'Escape' && s.query) { ev.stopPropagation(); setQuery(''); } }}
          data-testid="files-search" />
      </div>
      <div className="lib-filters" role="group" aria-label="Show">
        {(['all', 'video', 'audio', 'image'] as KindFilter[]).map((k) => <button key={k} className={s.kind === k ? 'chip on' : 'chip'} aria-pressed={s.kind === k} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k === 'image' ? 'Images' : k[0]!.toUpperCase() + k.slice(1)}</button>)}
      </div>
      <div className="fb-tree scroll" role="tree" aria-label="Files" aria-multiselectable="true" onKeyDown={onKey} data-testid="files-tree"
        onFocus={(ev) => { if (ev.target === ev.currentTarget && !s.focus && rows[0]) selectRow(rows[0].entry.path, rows); }} tabIndex={rows.length && !s.focus ? 0 : -1}>
        {rows.map((r) => (
          <RowView key={r.entry.path} row={r} rows={rows} inProject={inProject.has(r.entry.path)} focused={s.focus === r.entry.path} selected={s.selected.includes(r.entry.path)} open={!!s.expanded[r.entry.path]} />
        ))}
        {!rows.length && (
          <div className="fb-none hint">
            {s.error ? s.error : s.search ? `Nothing matches "${s.search.q}".` : s.searching ? 'Searching...' : rootListing ? 'No video, audio or images in this folder.' : 'Loading...'}
          </div>
        )}
      </div>
      <div className="fb-status hint" data-testid="files-status">
        {s.search ? `${s.search.results.length}${s.search.truncated ? '+' : ''} found` : rootListing ? `${rootListing.entries.length} item${rootListing.entries.length === 1 ? '' : 's'}${rootListing.skipped ? `, ${rootListing.skipped} other file${rootListing.skipped === 1 ? '' : 's'} hidden` : ''}` : ''}
      </div>
      <Preview entries={selectedEntries} />
    </div>
  );
}

registerEditPanel({ id: 'files', label: 'Files', component: FilesPanel, order: 5 });
registerCommands([
  {
    id: 'files.open', title: 'Browse files', group: 'Edit',
    description: 'Show the Files panel: your content folder, ready to add to the timeline',
    run: () => { useShell.getState().setWorkspace('edit'); setEdit({ panel: 'files' }); setTimeout(() => (document.querySelector('[data-testid="files-search"]') as HTMLElement | null)?.focus(), 50); },
  },
  {
    id: 'files.openFolder', title: 'Open a media folder', group: 'Edit',
    description: 'Pick the folder you keep your footage, music and images in; the Files panel shows it',
    run: () => { useShell.getState().setWorkspace('edit'); setEdit({ panel: 'files' }); void openFolder(); },
  },
]);
