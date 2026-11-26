import { useEffect, useState } from 'react';
import { timelineDuration, formatDuration } from '@director/engine';
import { EXPORT_PRESETS, renderThumbnail } from '@director/media';
import { useProject, ensureProject } from '../project/store';
import { useEdit } from '../edit/store';
import { invoke } from '../../shell/bridge';
import { useExports, enqueueExport, cancelExport } from './queue';
import './export.css';

function Cover({ dir }: { dir: string }) {
  const doc = useProject((s) => s.doc);
  const t = useEdit((s) => s.t);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string[]>([]);
  if (!doc) return null;
  const make = async (sizes: Array<[number, number]>) => {
    setBusy(true);
    const out: string[] = [];
    try {
      for (const [w, h] of sizes) {
        const blob = await renderThumbnail(doc, t, { width: w, height: h, title: title || undefined, format: 'jpeg' });
        const path = `${dir}/${doc.name.replace(/[\\/:*?"<>|]+/g, '-')} cover ${w}x${h}.jpg`;
        await invoke('file:writeImage', { path, data: new Uint8Array(await blob.arrayBuffer()) });
        out.push(path);
      }
      setDone(out);
    } finally { setBusy(false); }
  };
  (globalThis as Record<string, unknown>).__directorCover = { make: (sizes: Array<[number, number]>, ttl: string) => { setTitle(ttl); return renderThumbnail(doc, t, { width: sizes[0]![0], height: sizes[0]![1], title: ttl }); } };
  return (
    <div className="col" style={{ borderTop: '1px solid var(--line)', paddingTop: 12, gap: 8 }}>
      <h3>Cover and thumbnail</h3>
      <p className="hint">Uses the frame at the Edit playhead.</p>
      <input placeholder="Title on the cover (optional)" aria-label="Cover title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <div className="row"><button disabled={busy} onClick={() => void make([[1080, 1920]])}>Reels cover 1080x1920</button><button disabled={busy} onClick={() => void make([[1280, 720]])}>YouTube thumbnail 1280x720</button></div>
      {done.map((p) => <button key={p} className="mini" onClick={() => void invoke('shell:reveal', { path: p })}>Show {p.split('/').pop()}</button>)}
    </div>
  );
}

interface HistoryRow { id: string; path: string; preset: string; projectName: string; at: string; seconds: number; sizeBytes: number; loudness: { integrated: number; truePeak: number } | null; width: number; height: number }

export default function ExportWorkspace() {
  const doc = useProject((s) => s.doc);
  const jobs = useExports((s) => s.jobs);
  const { inPoint, outPoint } = useEdit();
  const [preset, setPreset] = useState('reels-30');
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [useRange, setUseRange] = useState(false);
  const [loud, setLoud] = useState(true);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  useEffect(() => { void ensureProject(); void invoke('export:defaultDir', {}).then(setDir); }, []);
  useEffect(() => { void invoke('export:history', {}).then((h) => setHistory(h as HistoryRow[])); }, [jobs.filter((j) => j.status === 'done').length]);
  useEffect(() => {
    if (!doc) return;
    const vertical = doc.canvas.height > doc.canvas.width;
    const square = doc.canvas.height === doc.canvas.width;
    setPreset((p) => (vertical && !p.startsWith('reels') ? 'reels-30' : !vertical && !square && p.startsWith('reels') ? 'youtube-1080' : square ? 'square-1080' : p));
    setName((n) => n || doc.name);
  }, [doc?.id, doc?.canvas.width, doc?.canvas.height]);

  if (!doc) return <div className="empty">Open a project to export.</div>;
  const dur = timelineDuration(doc);
  const hasRange = inPoint != null && outPoint != null && inPoint !== outPoint;
  const go = () => {
    const file = `${dir}/${(name || doc.name).replace(/[\\/:*?"<>|]+/g, '-')} ${preset}.mp4`;
    enqueueExport(doc, preset, file, { range: useRange && hasRange ? { from: Math.min(inPoint!, outPoint!), to: Math.max(inPoint!, outPoint!) } : undefined, loudness: loud });
  };
  const compatible = Object.entries(EXPORT_PRESETS).filter(([, p]) => (doc.canvas.height > doc.canvas.width ? p.platform === 'vertical' : doc.canvas.height === doc.canvas.width ? p.platform === 'square' : p.platform === 'landscape'));
  return (
    <div className="exp" data-testid="export-workspace">
      <section className="panel exp-form">
        <h3>Export "{doc.name}"</h3>
        <p className="hint">{formatDuration(dur)} · {doc.canvas.width}x{doc.canvas.height}</p>
        <div className="presets" role="radiogroup" aria-label="Preset">
          {compatible.map(([id, p]) => (
            <button key={id} role="radio" aria-checked={preset === id} className={preset === id ? 'preset on' : 'preset'} onClick={() => setPreset(id)} data-preset={id}>
              <strong>{p.label}</strong><span>{(p.videoBitrate / 1e6).toFixed(0)} Mbps {p.codec === 'hevc' ? 'HEVC' : 'H.264'}</span>
            </button>
          ))}
        </div>
        <label className="field-col">File name<input value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" /></label>
        <label className="field-col">Folder
          <span className="row"><input value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Folder" style={{ flex: 1 }} /><button onClick={() => void invoke('dialog:open', { directory: true, title: 'Export folder' }).then((p) => p[0] && setDir(p[0]))}>Choose</button></span>
        </label>
        <label className="row"><input type="checkbox" checked={loud} onChange={(e) => setLoud(e.target.checked)} /> Normalize loudness to -14 LUFS (true peak -1 dB)</label>
        <label className="row"><input type="checkbox" disabled={!hasRange} checked={useRange && hasRange} onChange={(e) => setUseRange(e.target.checked)} /> Only the in/out range {hasRange ? `(${formatDuration(Math.abs(outPoint! - inPoint!))})` : '(set I and O in Edit)'}</label>
        <button className="primary big" onClick={go} data-testid="export-button" disabled={dur <= 0}>Export</button>
        <Cover dir={dir} />
      </section>
      <section className="panel exp-jobs">
        <h3>Queue</h3>
        {jobs.length === 0 && <p className="hint">Exports run in the background; keep editing while they render.</p>}
        {jobs.map((j) => (
          <div key={j.id} className="job" data-job={j.id} data-status={j.status}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <strong>{j.path.split('/').pop()}</strong>
              <span className="hint">{j.status === 'rendering' ? `${Math.round(j.progress * 100)}%` : j.status}</span>
            </div>
            <div className="bar"><i style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
            {j.error && <div className="err">{j.error}</div>}
            {j.result && <div className="hint">{(j.result.sizeBytes / 1e6).toFixed(1)} MB{j.result.loudness ? ` · ${j.result.loudness.integrated.toFixed(1)} LUFS, peak ${j.result.loudness.truePeak.toFixed(1)} dBTP` : ''} · {((j.finishedAt! - j.startedAt) / 1000).toFixed(1)} s</div>}
            <div className="row">
              {['queued', 'audio', 'rendering'].includes(j.status) && <button className="mini" onClick={() => void cancelExport(j.id)}>Cancel</button>}
              {j.result && <button className="mini" onClick={() => void invoke('shell:reveal', { path: j.result!.path })}>Show in Finder</button>}
            </div>
          </div>
        ))}
        <h3 style={{ marginTop: 18 }}>Last exports</h3>
        <div className="scroll" data-testid="export-history">
          {history.map((h) => (
            <div key={h.id} className="hist">
              <span>{h.path.split('/').pop()}</span>
              <span className="hint">{EXPORT_PRESETS[h.preset]?.label ?? h.preset} · {new Date(h.at).toLocaleString()}</span>
              <button className="mini" onClick={() => void invoke('shell:reveal', { path: h.path })}>Show</button>
            </div>
          ))}
          {history.length === 0 && <p className="hint">Nothing exported yet.</p>}
        </div>
      </section>
    </div>
  );
}
