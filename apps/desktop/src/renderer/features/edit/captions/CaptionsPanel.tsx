import { useMemo, useState } from 'react';
import { timelineWords, captionOps, captionsToSubtitles, CAPTION_STYLES, DEFAULT_CAPTIONS, type CaptionOptions } from '@director/analysis';
import { useProject } from '../../project/store';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { ensureTranscripts } from '../transcript/transcripts';
import { registerEditPanel } from '../panels';

export function CaptionsPanel() {
  const doc = useProject((s) => s.doc);
  const [o, setO] = useState<CaptionOptions>(DEFAULT_CAPTIONS);
  const [busy, setBusy] = useState(false);
  const words = useMemo(() => (doc ? timelineWords(doc) : []), [doc]);
  const count = doc?.lanes.find((l) => l.kind === 'captions')?.clips.length ?? 0;
  const generate = async () => {
    setBusy(true);
    try {
      if (!words.length) await ensureTranscripts();
      const d = useProject.getState().doc!;
      useProject.getState().apply(captionOps(d, timelineWords(d), o), 'Generate captions');
      void invoke('settings:set', { key: 'captions.style', value: o.styleId });
    } finally { setBusy(false); }
  };
  const save = async (format: 'srt' | 'vtt') => {
    if (!doc) return;
    const path = await invoke('dialog:save', { title: `Save ${format.toUpperCase()}`, defaultPath: `${doc.name}.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (!path) return;
    await invoke('file:writeText', { path, text: captionsToSubtitles(doc, format) });
    useShell.getState().toast(`Saved ${path.split('/').pop()}`, 'ok');
  };
  (globalThis as Record<string, unknown>).__directorCaptions = { generate, setOptions: (p: Partial<CaptionOptions>) => setO((x) => ({ ...x, ...p })), subtitles: (f: 'srt' | 'vtt') => captionsToSubtitles(useProject.getState().doc!, f) };
  if (!doc) return null;
  return (
    <div className="col" style={{ padding: 10, gap: 10 }} data-testid="captions-panel">
      <div className="style-grid">
        {CAPTION_STYLES.map((s) => (
          <button key={s.id} className={o.styleId === s.id ? 'style on' : 'style'} onClick={() => setO({ ...o, styleId: s.id })} aria-pressed={o.styleId === s.id}
            style={{ color: s.text.color, fontWeight: s.text.weight, textShadow: s.text.stroke ? '0 0 3px #000, 0 0 3px #000' : undefined, background: s.text.box ? s.text.box.color : undefined }}>
            {s.text.uppercase ? 'YOUR WORDS' : 'Your words'} <span style={{ color: s.text.highlightColor ?? s.text.color }}>{s.text.uppercase ? 'HERE' : 'here'}</span>
          </button>
        ))}
      </div>
      <div className="field"><label>Words per card</label><input type="range" min={1} max={8} value={o.maxWords} aria-label="Words per card" onChange={(e) => setO({ ...o, maxWords: Number(e.target.value) })} /><span className="unit">{o.maxWords}</span></div>
      <div className="field"><label>Position</label><input type="range" min={0.2} max={0.82} step={0.01} value={o.position ?? CAPTION_STYLES.find((s) => s.id === o.styleId)!.position} aria-label="Caption position" onChange={(e) => setO({ ...o, position: Number(e.target.value) })} /></div>
      <button className="primary" disabled={busy} onClick={() => void generate()} data-testid="captions-generate">{busy ? 'Working' : count ? 'Regenerate captions' : 'Generate captions'}</button>
      <div className="row"><button className="mini" disabled={!count} onClick={() => void save('srt')}>Save SRT</button><button className="mini" disabled={!count} onClick={() => void save('vtt')}>Save VTT</button></div>
      <p className="hint">{count} caption cards. Captions burn into the export; SRT/VTT files are for platforms that upload subtitles separately.</p>
    </div>
  );
}

registerEditPanel({ id: 'captions', label: 'Captions', component: CaptionsPanel, order: 30 });
