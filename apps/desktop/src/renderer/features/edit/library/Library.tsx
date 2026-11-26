import { useEffect, useMemo, useState } from 'react';
import { formatDuration, type MediaRef } from '@director/engine';
import { mediaUrl } from '@director/media';
import { useProject } from '../../project/store';
import { invoke } from '../../../shell/bridge';
import { importPaths, importViaDialog, checkMissing, relink } from './store';
import { addMediaToTimeline } from '../commands';

const thumbCache = new Map<string, string | null>();

function Thumb({ m }: { m: MediaRef }) {
  const [src, setSrc] = useState<string | null>(thumbCache.get(m.hash) ?? null);
  useEffect(() => {
    if (thumbCache.has(m.hash)) return;
    void invoke('media:derived', { hash: m.hash, projectDir: useProject.getState().dir ?? undefined }).then((d) => {
      const url = d.thumbs ? mediaUrl(d.thumbs) : null;
      thumbCache.set(m.hash, url);
      setSrc(url);
    }).catch(() => thumbCache.set(m.hash, null));
  }, [m.hash]);
  if (m.kind === 'audio') return <div className="thumb audio" aria-hidden>♪</div>;
  if (!src) return <div className="thumb" aria-hidden />;
  return <div className="thumb" style={{ backgroundImage: `url("${src}")`, backgroundPositionX: '0%', backgroundSize: m.kind === 'image' ? 'cover' : `${12 * 100}% 100%` }} aria-hidden />;
}

type Kind = 'all' | 'video' | 'audio' | 'image';

export function Library() {
  const doc = useProject((s) => s.doc);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [tag, setTag] = useState<string>('');
  const [minDur, setMinDur] = useState(0);
  const [over, setOver] = useState(false);

  useEffect(() => { if (doc) void checkMissing(); }, [doc?.id]);

  const media = useMemo(() => Object.values(doc?.media ?? {}), [doc?.media]);
  const tags = useMemo(() => [...new Set(media.flatMap((m) => m.tags ?? []))].sort(), [media]);
  const list = filterMedia(media, { q, kind, tag, minDurUs: minDur * 1e6 });
  (globalThis as Record<string, unknown>).__directorLibrary = { filterMedia, importPaths, relink, checkMissing, visible: () => list.map((m) => m.id) };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    // Tests can supply the OS path lookup (the preload bridge is frozen).
    const lookup = ((globalThis as Record<string, unknown>).__directorPathForFile as ((f: File) => string) | undefined) ?? window.director.pathForFile;
    const paths = [...e.dataTransfer.files].map((f) => lookup(f)).filter(Boolean);
    void importPaths(paths);
  };

  const setTags = (m: MediaRef, next: string[]) => useProject.getState().apply([{ op: 'updateMedia', id: m.id, patch: { tags: next } }], 'Tag media');

  return (
    <div className={`library ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop} data-testid="library">
      <div className="lib-bar">
        <button className="primary" onClick={() => void importViaDialog()} data-testid="import-button">Import</button>
        <input placeholder="Search media" aria-label="Search media" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="lib-filters">
        {(['all', 'video', 'audio', 'image'] as Kind[]).map((k) => <button key={k} className={kind === k ? 'chip on' : 'chip'} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k[0]!.toUpperCase() + k.slice(1)}</button>)}
        {tags.length > 0 && <select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)}><option value="">Any tag</option>{tags.map((t) => <option key={t}>{t}</option>)}</select>}
        <select aria-label="Minimum length" value={minDur} onChange={(e) => setMinDur(Number(e.target.value))}><option value={0}>Any length</option><option value={5}>5 s+</option><option value={30}>30 s+</option><option value={60}>1 min+</option></select>
      </div>
      <div className="lib-grid scroll">
        {list.map((m) => (
          <div key={m.id} className={`lib-item ${m.missing ? 'missing' : ''}`} data-media={m.id} draggable={!m.missing}
            onDragStart={(e) => { e.dataTransfer.setData('application/x-director-media', m.id); e.dataTransfer.effectAllowed = 'copy'; }}
            onDoubleClick={() => !m.missing && addMediaToTimeline(m)} title={`${m.name}\n${m.path}`}>
            <Thumb m={m} />
            <div className="lib-name">{m.name}</div>
            <div className="lib-meta">{m.kind === 'image' ? 'Image' : formatDuration(m.durationUs)}{m.width ? ` · ${m.width}x${m.height}` : ''}{m.proxyPath ? ' · proxy' : ''}</div>
            {m.missing && <button className="mini danger" onClick={() => void relink(m)}>Relink</button>}
            <input className="lib-tags" aria-label={`Tags for ${m.name}`} placeholder="tags" defaultValue={(m.tags ?? []).join(', ')} onBlur={(e) => setTags(m, e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
          </div>
        ))}
        {list.length === 0 && <div className="empty" style={{ gridColumn: '1 / -1' }}>{media.length ? 'No media matches.' : 'Drop video, audio or images here, or click Import.'}</div>}
      </div>
    </div>
  );
}

export function filterMedia(media: MediaRef[], f: { q?: string; kind?: Kind; tag?: string; minDurUs?: number }): MediaRef[] {
  const q = (f.q ?? '').trim().toLowerCase();
  return media
    .filter((m) => (f.kind && f.kind !== 'all' ? m.kind === f.kind : true))
    .filter((m) => (f.tag ? (m.tags ?? []).includes(f.tag) : true))
    .filter((m) => (f.minDurUs ? m.kind !== 'image' && m.durationUs >= f.minDurUs : true))
    .filter((m) => (q ? `${m.name} ${(m.tags ?? []).join(' ')}`.toLowerCase().includes(q) : true))
    .sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}
