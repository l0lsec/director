import { useEffect, useMemo, useState } from 'react';
import './swipe.css';
import type { Reference, RefSort, RefPatch } from '@director/library';
import { mediaUrl } from '@director/media';
import { invoke } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { lib, useBrand, loadBrands, setActiveBrand, createBrand, libraryChanged } from '../../shell/library';
import { registerCommands } from '../palette/registry';
import { Analyzer } from './analyzer/Analyzer';
import { openDraftFrom } from '../script/scriptStore';
import { ask } from '../../shell/prompt';

type Scope = { kind: 'all' } | { kind: 'folder'; folder: string } | { kind: 'kit'; id: string } | { kind: 'tag'; tag: string };
const nf = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const VIDEO_FILTERS = [{ name: 'Videos', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv'] }];

async function importInto(brandId: string, paths: string[], folder?: string): Promise<void> {
  const toast = useShell.getState().toast;
  const r = await invoke('swipe:import', { brandId, paths, folder });
  libraryChanged();
  const parts = [`${r.added.length} added`];
  if (r.duplicates.length) parts.push(`${r.duplicates.length} already in the library`);
  if (r.restored.length) parts.push(`${r.restored.length} restored`);
  if (r.failed.length) parts.push(`${r.failed.length} skipped`);
  toast(`Import: ${parts.join(', ')}`, r.failed.length && !r.added.length ? 'error' : 'ok');
}

/**
 * A text field that edits a saved value: it keeps your draft while focused, saves on blur (or Enter)
 * when changed, and follows the saved value whenever you are not editing it.
 */
function Field({ label, value, onCommit, multiline, placeholder, numeric }: { label: string; value: string; onCommit: (v: string) => void; multiline?: boolean; placeholder?: string; numeric?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (!editing) setDraft(value); }, [value, editing]);
  const commit = () => { setEditing(false); if (draft !== value) onCommit(draft); };
  const common = {
    value: draft, placeholder, 'aria-label': label,
    onFocus: () => setEditing(true),
    onBlur: commit,
    onChange: (e: { target: { value: string } }) => setDraft(numeric ? e.target.value.replace(/[^\d]/g, '') : e.target.value),
  };
  return (
    <label className="field">{label}
      {multiline ? <textarea rows={3} {...common} /> : <input inputMode={numeric ? 'numeric' : undefined} {...common} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />}
    </label>
  );
}

const numOrNull = (v: string) => (v === '' ? null : Number(v));

function Detail({ brandId, r, kits }: { brandId: string; r: Reference; kits: Array<{ id: string; name: string }> }) {
  const toast = useShell((s) => s.toast);
  const save = async (patch: RefPatch) => {
    try { await lib('swipe.update', brandId, r.id, patch); libraryChanged(); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="swipe-detail" data-testid="ref-detail" data-ref={r.id} key={r.id}>
      {r.path && <video src={mediaUrl(r.path)} controls preload="metadata" aria-label={`Preview of ${r.title}`} />}
      <Field label="Title" value={r.title} onCommit={(v) => { if (v.trim()) void save({ title: v }); }} />
      <div className="grid2">
        <Field label="Views" numeric value={r.views == null ? '' : String(r.views)} onCommit={(v) => void save({ views: numOrNull(v) })} />
        <Field label="Likes" numeric value={r.likes == null ? '' : String(r.likes)} onCommit={(v) => void save({ likes: numOrNull(v) })} />
        <Field label="Comments" numeric value={r.comments == null ? '' : String(r.comments)} onCommit={(v) => void save({ comments: numOrNull(v) })} />
        <Field label="Shares" numeric value={r.shares == null ? '' : String(r.shares)} onCommit={(v) => void save({ shares: numOrNull(v) })} />
      </div>
      <p className="hint">{r.engagement != null ? `Engagement ${(r.engagement * 100).toFixed(1)}% · ` : ''}{r.durationUs ? `${(r.durationUs / 1e6).toFixed(1)} s · ` : ''}{r.width && r.height ? `${r.width}x${r.height}` : ''}{r.platform ? ` · ${r.platform}` : ''}</p>
      <Field label="Source link" placeholder="https://" value={r.sourceUrl ?? ''} onCommit={(v) => void save({ sourceUrl: v || null })} />
      <div className="grid2">
        <Field label="Folder" placeholder="e.g. Hooks/Questions" value={r.folder} onCommit={(v) => void save({ folder: v })} />
        <label className="field">Kit
          <select value={r.kitId ?? ''} onChange={(e) => void save({ kitId: e.target.value || null })} aria-label="Kit">
            <option value="">No kit</option>
            {kits.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
        </label>
      </div>
      <Field label="Tags" placeholder="hook, list, b-roll" value={r.tags.join(', ')} onCommit={(v) => void lib('swipe.setTags', brandId, r.id, v.split(',')).then(libraryChanged).catch((e) => toast((e as Error).message, 'error'))} />
      <Field label="Notes" multiline value={r.notes} onCommit={(v) => void save({ notes: v })} />
      <h4>Analysis</h4>
      <Analyzer brandId={brandId} reference={r} />
      <div className="row">
        <button className="primary" onClick={() => openDraftFrom(r)} data-testid="draft-from-ref">Draft my version</button>
        <button onClick={() => void invoke('shell:reveal', { path: r.path })}>Show in Finder</button>
        <button className="danger" onClick={() => void lib('swipe.remove', brandId, r.id).then(() => { libraryChanged(); toast('Removed from the library. Re-import the file to restore it.', 'info'); })}>Remove</button>
      </div>
    </div>
  );
}

export default function SwipeWorkspace() {
  const { brands, activeId, version } = useBrand();
  const toast = useShell((s) => s.toast);
  const [refs, setRefs] = useState<Reference[]>([]);
  const [folders, setFolders] = useState<Array<{ folder: string; count: number }>>([]);
  const [kits, setKits] = useState<Array<{ id: string; name: string; count: number }>>([]);
  const [tags, setTags] = useState<Array<{ tag: string; count: number }>>([]);
  const [scope, setScope] = useState<Scope>({ kind: 'all' });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<RefSort>('added');
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (!activeId) void loadBrands(); }, [activeId]);
  useEffect(() => {
    if (!activeId) return;
    const query = { q: q || undefined, sort, ...(scope.kind === 'folder' ? { folder: scope.folder } : scope.kind === 'kit' ? { kitId: scope.id } : scope.kind === 'tag' ? { tag: scope.tag } : {}) };
    // Responses can arrive out of order; only the latest request may update the view.
    let live = true;
    void Promise.all([lib('swipe.list', activeId, query), lib('swipe.folders', activeId), lib('swipe.kits', activeId), lib('swipe.tags', activeId)]).then(([r, f, k, t]) => {
      if (!live) return;
      setRefs(r); setFolders(f); setKits(k); setTags(t);
    });
    return () => { live = false; };
  }, [activeId, version, q, sort, scope]);
  useEffect(() => { setScope({ kind: 'all' }); setSelected(null); }, [activeId]);
  const current = useMemo(() => refs.find((r) => r.id === selected) ?? null, [refs, selected]);
  if (!activeId) return <div className="empty">Loading library</div>;

  const pick = async (directory: boolean) => {
    const paths = await invoke('dialog:open', { title: directory ? 'Import a folder of references' : 'Import reference videos', multi: !directory, directory, filters: directory ? undefined : VIDEO_FILTERS });
    if (paths.length) await importInto(activeId, paths, scope.kind === 'folder' ? scope.folder : undefined);
  };
  const byLink = async () => {
    const url = await ask({ title: 'Import by link', label: 'Paste a link to a reel or video. Director downloads it with yt-dlp into your own reference library.', placeholder: 'https://', confirm: 'Download' });
    if (!url) return;
    setBusy(true);
    try {
      const r = await invoke('swipe:importUrl', { brandId: activeId, url });
      libraryChanged();
      toast(r.added.length ? 'Downloaded and added' : r.duplicates.length ? 'Already in the library' : 'Nothing added', 'ok');
    } catch (e) { toast((e as Error).message, 'error'); } finally { setBusy(false); }
  };
  const newKit = async () => {
    const name = await ask({ title: 'New kit', label: 'A set of references for one series or campaign', confirm: 'Create' });
    if (name?.trim()) { await lib('swipe.createKit', activeId, name); libraryChanged(); }
  };
  const isScope = (s: Scope) => JSON.stringify(s) === JSON.stringify(scope);

  return (
    <div
      className={`swipe${drag ? ' dropzone' : ''}`}
      data-testid="swipe-workspace"
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); const pathFor = ((globalThis as Record<string, unknown>).__directorPathForFile as ((f: File) => string) | undefined) ?? window.director.pathForFile; const paths = [...e.dataTransfer.files].map((f) => pathFor(f)).filter(Boolean); if (paths.length) void importInto(activeId, paths, scope.kind === 'folder' ? scope.folder : undefined); }}
    >
      <aside className="panel swipe-side" aria-label="Library">
        <div className="panel-title">Brand</div>
        <div className="row" style={{ padding: '0 12px 0 0' }}>
          <select value={activeId} onChange={(e) => void setActiveBrand(e.target.value)} aria-label="Brand" data-testid="brand-select" style={{ flex: 1 }}>
            {brands.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <button className="mini" title="New brand" aria-label="New brand" onClick={() => void ask({ title: 'New brand', label: 'Each brand has its own references, voices, hooks, scripts and caption presets.', confirm: 'Create' }).then((n) => { if (n?.trim()) return createBrand(n); }).catch((e) => toast((e as Error).message, 'error'))}>+</button>
        </div>
        <div className="panel-title">Library</div>
        <div className="nav">
          <button aria-pressed={isScope({ kind: 'all' })} onClick={() => setScope({ kind: 'all' })}>All references</button>
        </div>
        {folders.length > 0 && <div className="panel-title">Folders</div>}
        <div className="nav">{folders.map((f) => <button key={f.folder} aria-pressed={isScope({ kind: 'folder', folder: f.folder })} onClick={() => setScope({ kind: 'folder', folder: f.folder })} style={{ paddingLeft: 8 + 12 * (f.folder.split('/').length - 1) }}><span>{f.folder.split('/').pop()}</span><span className="n">{f.count}</span></button>)}</div>
        <div className="panel-title row" style={{ justifyContent: 'space-between' }}>Kits <button className="mini" onClick={() => void newKit()} aria-label="New kit">+</button></div>
        <div className="nav">{kits.map((k) => <button key={k.id} aria-pressed={isScope({ kind: 'kit', id: k.id })} onClick={() => setScope({ kind: 'kit', id: k.id })}><span>{k.name}</span><span className="n">{k.count}</span></button>)}</div>
        {tags.length > 0 && <div className="panel-title">Tags</div>}
        <div className="nav">{tags.map((t) => <button key={t.tag} aria-pressed={isScope({ kind: 'tag', tag: t.tag })} onClick={() => setScope({ kind: 'tag', tag: t.tag })}><span>#{t.tag}</span><span className="n">{t.count}</span></button>)}</div>
      </aside>
      <section className="panel swipe-main">
        <div className="swipe-bar">
          <button className="primary" onClick={() => void pick(false)} data-testid="import-files">Import videos</button>
          <button onClick={() => void pick(true)}>Import folder</button>
          <button onClick={() => void byLink()} disabled={busy} title="Downloads with yt-dlp">{busy ? 'Downloading...' : 'Import link'}</button>
          <input type="search" placeholder="Search titles, notes, creators, tags" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search references" />
          <select value={sort} onChange={(e) => setSort(e.target.value as RefSort)} aria-label="Sort">
            <option value="added">Newest</option><option value="views">Most views</option><option value="engagement">Best engagement</option><option value="likes">Most likes</option><option value="duration">Longest</option><option value="title">Title</option>
          </select>
        </div>
        {refs.length === 0 ? (
          <div className="empty">
            <div className="col" style={{ alignItems: 'center' }}>
              <strong>Your swipe file is empty</strong>
              <span>Drop reels here, or import videos you saved. Track their stats, tag what works, analyze pacing and structure, then draft your own version.</span>
            </div>
          </div>
        ) : (
          <div className="swipe-grid" data-testid="ref-grid" aria-label="References">
            {refs.map((r) => (
              <button key={r.id} className="ref-card" aria-pressed={r.id === selected} onClick={() => setSelected(r.id)} data-ref={r.id}>
                <video src={`${mediaUrl(r.path)}#t=0.5`} preload="metadata" muted aria-hidden />
                <div className="meta">
                  <span className="title" title={r.title}>{r.title}</span>
                  <span className="stats">{r.views != null ? `${nf.format(r.views)} views` : 'no stats'}{r.engagement != null ? ` · ${(r.engagement * 100).toFixed(1)}%` : ''}{r.durationUs ? ` · ${(r.durationUs / 1e6).toFixed(0)} s` : ''}</span>
                  {r.tags.length > 0 && <span className="tagrow">{r.tags.slice(0, 3).map((t) => <span key={t} className="chip">#{t}</span>)}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>
      <aside className="panel" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {current ? <Detail brandId={activeId} r={current} kits={kits} /> : <div className="empty">Select a reference to see its stats, pacing and structure.</div>}
      </aside>
    </div>
  );
}

registerCommands([
  { id: 'swipe.import', title: 'Import references', group: 'Swipe', description: 'Add reference videos to the swipe file', run: async () => { useShell.getState().setWorkspace('swipe'); const b = useBrand.getState().activeId ?? (await loadBrands()); const p = await invoke('dialog:open', { title: 'Import reference videos', multi: true, filters: VIDEO_FILTERS }); if (p.length) await importInto(b, p); } },
]);
(globalThis as Record<string, unknown>).__directorSwipe = { importInto };
