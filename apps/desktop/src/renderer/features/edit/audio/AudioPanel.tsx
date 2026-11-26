import { useEffect, useMemo, useRef, useState } from 'react';
import { formatDuration, type Clip } from '@director/engine';
import { mediaUrl } from '@director/media';
import { invoke } from '../../../shell/bridge';
import { registerEditPanel } from '../panels';
import { registerEditExtensions } from '../inspector/extensions';
import { patchClip } from '../inspector/Inspector';
import { importPaths } from '../library/store';
import { addMediaToTimeline } from '../commands';
import { useProject } from '../../project/store';
import { processClipAudio, addBeatMarkers } from './audioTools';

type Item = { path: string; name: string; folder: string; durationUs: number; kind: 'music' | 'sfx' };

export function AudioPanel() {
  const [folders, setFolders] = useState<string[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'all' | 'music' | 'sfx'>('all');
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const scan = async (f?: string[]) => setItems(await invoke('audiolib:scan', { folders: f }));
  useEffect(() => { void invoke('audiolib:folders', {}).then((f) => { setFolders(f); void scan(f); }); }, []);
  const addFolder = async () => {
    const [p] = await invoke('dialog:open', { directory: true, title: 'Add a music or sound-effects folder' });
    if (!p) return;
    const next = [...new Set([...folders, p])];
    setFolders(next);
    await invoke('audiolib:setFolders', { folders: next });
    await scan(next);
  };
  const preview = (it: Item) => {
    audio.current?.pause();
    if (playing === it.path) { setPlaying(null); return; }
    audio.current = new Audio(mediaUrl(it.path));
    void audio.current.play();
    audio.current.onended = () => setPlaying(null);
    setPlaying(it.path);
  };
  const add = async (it: Item) => {
    const [m] = await importPaths([it.path], it.kind === 'sfx' ? 'sfx' : 'music');
    const media = m ?? Object.values(useProject.getState().doc!.media).find((x) => x.path === it.path);
    if (media) addMediaToTimeline({ ...media, role: it.kind === 'sfx' ? 'sfx' : 'music' });
    // Music added from the library ducks under the voice by default.
    const doc = useProject.getState().doc!;
    const lane = doc.lanes.find((l) => l.kind === (it.kind === 'sfx' ? 'sfx' : 'music'))!;
    const c = lane.clips.find((x) => x.mediaId === media?.id && !x.audio?.duckable);
    if (c && it.kind === 'music') patchClip(c.id, { audio: { ...c.audio!, duckable: true, gainDb: { value: -8 } } }, 'Duck music under voice');
  };
  const list = useMemo(() => items.filter((i) => (kind === 'all' || i.kind === kind) && i.name.toLowerCase().includes(q.toLowerCase())), [items, kind, q]);
  (globalThis as Record<string, unknown>).__directorAudioLib = { items: () => items, scan, setFolders: async (f: string[]) => { setFolders(f); await invoke('audiolib:setFolders', { folders: f }); await scan(f); } };
  return (
    <div className="col" style={{ minHeight: 0, flex: 1 }} data-testid="audio-panel">
      <div className="lib-bar"><button className="primary" onClick={() => void addFolder()}>Add folder</button><input placeholder="Search sounds" aria-label="Search sounds" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="lib-filters">{(['all', 'music', 'sfx'] as const).map((k) => <button key={k} className={kind === k ? 'chip on' : 'chip'} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k === 'music' ? 'Music' : 'SFX'}</button>)}<button className="chip" onClick={() => void scan(folders)}>Rescan</button></div>
      <div className="scroll" style={{ flex: 1 }}>
        {list.map((it) => (
          <div key={it.path} className="cutrow" data-sound={it.name} onDoubleClick={() => void add(it)} title={it.path}>
            <button className="mini" aria-label={`Preview ${it.name}`} onClick={() => preview(it)}>{playing === it.path ? 'Stop' : 'Play'}</button>
            <span>{it.name}</span>
            <span className="hint">{it.kind} · {formatDuration(it.durationUs)}</span>
          </div>
        ))}
        {!list.length && <div className="empty">{folders.length ? 'No audio found in your folders.' : 'Add your music and sound-effects folders. Double-click a sound to place it at the playhead.'}</div>}
      </div>
    </div>
  );
}

function AudioExtras({ clip }: { clip: Clip }) {
  const doc = useProject((s) => s.doc);
  const lane = doc?.lanes.find((l) => l.clips.some((c) => c.id === clip.id));
  const [busy, setBusy] = useState('');
  const run = async (label: string, fn: () => Promise<unknown>) => { setBusy(label); try { await fn(); } finally { setBusy(''); } };
  const isMusic = lane?.kind === 'music' || lane?.kind === 'sfx';
  const depth = typeof clip.meta?.duckDb === 'number' ? (clip.meta.duckDb as number) : -12;
  return (
    <>
      {isMusic && (
        <>
          <div className="field"><label>Duck under voice</label><input type="checkbox" checked={!!clip.audio?.duckable} onChange={(e) => patchClip(clip.id, { audio: { ...clip.audio!, duckable: e.target.checked } }, 'Ducking')} /></div>
          {clip.audio?.duckable && <div className="field"><label>Duck by</label><input type="range" min={-30} max={-3} step={1} value={depth} aria-label="Duck depth" onChange={(e) => patchClip(clip.id, { meta: { ...clip.meta, duckDb: Number(e.target.value) } }, 'Duck depth')} /><span className="unit">{depth} dB</span></div>}
          <button className="mini" disabled={!!busy} onClick={() => void run('beats', () => addBeatMarkers(clip))}>{busy === 'beats' ? 'Finding beats' : 'Add beat markers'}</button>
        </>
      )}
      {!isMusic && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button className="mini" disabled={!!busy} onClick={() => void run('dn', () => processClipAudio(clip, { denoise: true }))}>{busy === 'dn' ? 'Cleaning' : 'Remove noise'}</button>
          <button className="mini" disabled={!!busy} onClick={() => void run('en', () => processClipAudio(clip, { denoise: true, enhance: true }))}>{busy === 'en' ? 'Enhancing' : 'Enhance voice'}</button>
        </div>
      )}
    </>
  );
}

registerEditPanel({ id: 'audio', label: 'Audio', component: AudioPanel, order: 40 });
registerEditExtensions({ audio: (clip) => <AudioExtras clip={clip} /> });
(globalThis as Record<string, unknown>).__directorAudioTools = { processClipAudio, addBeatMarkers };
