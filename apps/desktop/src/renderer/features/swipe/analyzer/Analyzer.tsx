import { useMemo, useState } from 'react';
import type { Reference } from '@director/library';
import type { Structure } from '@director/ai';
import { comparePacing, editPacing, timelineWords, type Pacing, type PacingDelta } from '@director/analysis';
import type { Project } from '@director/engine';
import type { RefAnalysis } from '../../../../main/library/handlers';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { libraryChanged } from '../../../shell/library';
import { useProject } from '../../project/store';

const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '-');

export function PacingStats({ p }: { p: Pacing }) {
  const stats: Array<[string, string]> = [
    ['Length', `${fmt(p.durationSec)} s`], ['Shots', String(p.shotCount)], ['Avg shot', `${fmt(p.avgShotSec, 2)} s`],
    ['Cuts / min', fmt(p.cutsPerMin)], ['First cut', p.firstCutSec == null ? 'none' : `${fmt(p.firstCutSec, 2)} s`], ['Words / s', fmt(p.wordsPerSec, 2)],
  ];
  return <div className="pacing" data-testid="pacing">{stats.map(([k, v]) => <div key={k} className="stat"><b>{v}</b><span>{k}</span></div>)}</div>;
}

export function ShotBar({ cuts, duration }: { cuts: number[]; duration: number }) {
  return <div className="shotbar" role="img" aria-label={`${cuts.length} cuts`}>{cuts.map((c) => <i key={c} style={{ left: `${(c / duration) * 100}%` }} />)}</div>;
}

export function SegmentBar({ s }: { s: Structure }) {
  return (
    <div className="segbar" data-testid="segbar" role="img" aria-label={`Structure: ${s.segments.map((g) => g.label).join(", ")}`}>
      {s.segments.map((g, i) => <span key={i} className={`seg-${g.label}`} title={`${g.label}: ${g.summary}`} style={{ left: `${(g.start / s.durationSec) * 100}%`, width: `${((g.end - g.start) / s.durationSec) * 100}%` }}>{g.end - g.start > s.durationSec * 0.08 ? g.label : ''}</span>)}
    </div>
  );
}

/** Your open edit against this reference, metric by metric. */
export function compareWithEdit(doc: Project, ref: Pacing): PacingDelta[] {
  const words = timelineWords(doc).map((w) => ({ text: w.text, start: w.start / 1e6, end: w.end / 1e6 }));
  return comparePacing(editPacing(doc, words), ref);
}

export function CompareTable({ deltas }: { deltas: PacingDelta[] }) {
  const unit = (m: string) => (m.endsWith('Sec') ? ' s' : m === 'speechRatio' ? '' : '');
  return (
    <table className="compare" data-testid="compare">
      <thead><tr><th>Metric</th><th>Yours</th><th>Reference</th><th>Diff</th></tr></thead>
      <tbody>
        {deltas.flatMap((d) => [
          <tr key={d.metric}><td>{d.label}</td><td>{fmt(d.yours, 2)}{unit(d.metric)}</td><td>{fmt(d.reference, 2)}{unit(d.metric)}</td><td>{d.pct == null ? fmt(d.delta, 2) : `${d.pct > 0 ? '+' : ''}${d.pct.toFixed(0)}%`}</td></tr>,
          d.note ? <tr key={`${d.metric}-n`} className="note"><td colSpan={4}>{d.note}</td></tr> : null,
        ])}
      </tbody>
    </table>
  );
}

export function Analyzer({ brandId, reference }: { brandId: string; reference: Reference }) {
  const toast = useShell((s) => s.toast);
  const doc = useProject((s) => s.doc);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const a = reference.analysis as (RefAnalysis & { structure?: Structure }) | null;
  const deltas = useMemo(() => (a && doc ? compareWithEdit(doc, a.pacing) : null), [a, doc]);

  const run = async (what: 'analyze' | 'structure') => {
    setBusy(what); setError(null);
    try {
      if (what === 'analyze') {
        const r = await invoke('swipe:analyze', { brandId, id: reference.id });
        toast(`Found ${r.shots.length} shots${r.transcribed ? '' : ' (no transcript: install a transcription model in Edit to get words per second)'}`, 'ok');
      } else {
        const r = await invoke('claude:structure', { brandId, refId: reference.id });
        toast(`Structure labelled (${r.structure.segments.length} parts, $${r.costUsd.toFixed(4)})`, 'ok');
      }
      libraryChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(null); }
  };

  return (
    <div className="col" data-testid="analyzer">
      <div className="row">
        <button onClick={() => void run('analyze')} disabled={!!busy} data-testid="analyze">{busy === 'analyze' ? 'Analyzing...' : a ? 'Re-analyze' : 'Analyze pacing'}</button>
        <button onClick={() => void run('structure')} disabled={!!busy || !a} data-testid="label-structure" title={a ? 'Uses Claude: sends the transcript and shot times only' : 'Analyze first'}>{busy === 'structure' ? 'Labelling...' : 'Label structure (Claude)'}</button>
      </div>
      {error && <div className="err" role="alert">{error}</div>}
      {a && (
        <>
          <PacingStats p={a.pacing} />
          <ShotBar cuts={a.cuts} duration={a.durationSec} />
          {a.structure && (
            <>
              <SegmentBar s={a.structure} />
              <p className="hint">Hook: {a.structure.hookType}. {a.structure.overall}</p>
              <div className="seglist">{a.structure.segments.map((g, i) => <div key={i}><span className={`chip seg-${g.label}`} style={{ color: '#111' }}>{g.label}</span><span className="hint">{fmt(g.start)} to {fmt(g.end)} s</span><span>{g.summary}{g.technique ? <em className="hint"> ({g.technique})</em> : null}</span></div>)}</div>
            </>
          )}
          <h4>Compare with your edit</h4>
          {deltas ? <CompareTable deltas={deltas} /> : <p className="hint">Open a project in Edit to compare its pacing with this reference.</p>}
        </>
      )}
    </div>
  );
}
