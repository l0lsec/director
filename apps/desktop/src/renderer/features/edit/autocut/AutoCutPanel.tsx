import { useMemo, useState } from 'react';
import { timelineWords, planAutoCut, cutOps, removedDuration, DEFAULT_AUTOCUT, type AutoCutOptions } from '@director/analysis';
import { formatDuration } from '@director/engine';
import { useProject } from '../../project/store';
import { seek } from '../player';
import { ensureTranscripts } from '../transcript/transcripts';
import { registerEditPanel } from '../panels';

export function AutoCutPanel() {
  const doc = useProject((s) => s.doc);
  const [o, setO] = useState<AutoCutOptions>(DEFAULT_AUTOCUT);
  const [busy, setBusy] = useState(false);
  const words = useMemo(() => (doc ? timelineWords(doc) : []), [doc]);
  const plan = useMemo(() => (doc && words.length ? planAutoCut(doc, words, o) : []), [doc, words, o]);
  const apply = () => { if (doc && plan.length) useProject.getState().apply(cutOps(doc, plan), `AutoCut (${plan.length} cuts)`); };
  (globalThis as Record<string, unknown>).__directorAutoCut = { plan: () => plan, apply, setOptions: (p: Partial<AutoCutOptions>) => setO((x) => ({ ...x, ...p })) };
  if (!doc) return null;
  return (
    <div className="autocut" data-testid="autocut-panel">
      <div className="section col" style={{ padding: 10 }}>
        {!words.length && <button className="primary" disabled={busy} onClick={() => { setBusy(true); void ensureTranscripts().finally(() => setBusy(false)); }}>{busy ? 'Transcribing' : 'Transcribe first'}</button>}
        <div className="field"><label>Pauses over</label><input type="range" min={150} max={1500} step={25} value={o.minPause / 1000} aria-label="Minimum pause" onChange={(e) => setO({ ...o, minPause: Number(e.target.value) * 1000 })} /><span className="unit">{(o.minPause / 1e6).toFixed(2)} s</span></div>
        <div className="field"><label>Keep air</label><input type="range" min={0} max={300} step={10} value={o.keep / 1000} aria-label="Padding" onChange={(e) => setO({ ...o, keep: Number(e.target.value) * 1000 })} /><span className="unit">{(o.keep / 1000).toFixed(0)} ms</span></div>
        <label className="row"><input type="checkbox" checked={!!o.fillers} onChange={(e) => setO({ ...o, fillers: e.target.checked ? DEFAULT_AUTOCUT.fillers : false })} /> Remove filler words (um, uh, ah)</label>
        <label className="row"><input type="checkbox" checked={o.trimEnds} onChange={(e) => setO({ ...o, trimEnds: e.target.checked })} /> Trim silence at the start and end</label>
        <button className="primary" disabled={!plan.length} onClick={apply} data-testid="autocut-apply">Remove {plan.length} pauses and fillers ({formatDuration(removedDuration(plan))})</button>
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        {plan.map((r, i) => (
          <div key={i} className="cutrow" onClick={() => seek(Math.max(0, r.from - 500_000))}>
            <span className={`chip ${r.reason}`}>{r.reason}</span>
            <span>{r.label}</span>
            <span className="hint">{formatDuration(r.from)} · {((r.to - r.from) / 1e6).toFixed(2)} s</span>
          </div>
        ))}
      </div>
    </div>
  );
}

registerEditPanel({ id: 'effects', label: 'AutoCut', component: AutoCutPanel, order: 20 });
