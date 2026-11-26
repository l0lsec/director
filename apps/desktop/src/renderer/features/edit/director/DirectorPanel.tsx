import { useEffect, useMemo, useState } from 'react';
import { compileDirector, type DirectorAction, type ActionProblem } from '@director/ai/director/index';
import { timelineDuration } from '@director/engine';
import type { Reference } from '@director/library';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { lib, useBrand, loadBrands } from '../../../shell/library';
import { useProject } from '../../project/store';
import { registerEditPanel } from '../panels';
import { setEdit } from '../store';
import { registerCommands } from '../../palette/registry';
import { openSettings } from '../../settings/SettingsModal';

interface Proposal { summary: string; actions: DirectorAction[]; costUsd: number; problems: ActionProblem[]; baseVersion: number }
const f = (us: number) => (us / 1e6).toFixed(1);

/** Apply the kept actions of a proposal as one undo step. Recompiled against the current doc, all or nothing. */
export function applyDirector(actions: DirectorAction[], keep: Set<number>, summary: string): { ok: boolean; problems: ActionProblem[]; removedUs: number } {
  const doc = useProject.getState().doc;
  if (!doc) return { ok: false, problems: [{ index: -1, reason: 'no project open' }], removedUs: 0 };
  const plan = compileDirector(doc, actions, keep);
  if (!plan.ok) return { ok: false, problems: plan.problems, removedUs: 0 };
  const ok = plan.ops.length ? useProject.getState().apply(plan.ops, `Director: ${summary.slice(0, 50)}`) : true;
  return { ok, problems: [], removedUs: plan.removedUs };
}

export async function runDirector(goal: string, opts: { refId?: string | null; targetSec?: number | null } = {}) {
  const doc = useProject.getState().doc;
  if (!doc) throw new Error('Open a project first');
  const brandId = useBrand.getState().activeId ?? (await loadBrands());
  return invoke('claude:director', { doc, goal, brandId, refId: opts.refId ?? null, targetSec: opts.targetSec ?? null });
}

export function DirectorPanel() {
  const doc = useProject((s) => s.doc);
  const version = useProject((s) => s.version);
  const brandId = useBrand((s) => s.activeId);
  const toast = useShell((s) => s.toast);
  const [goal, setGoal] = useState('Tighten the pacing, remove dead air and add emphasis on the key points.');
  const [refs, setRefs] = useState<Reference[]>([]);
  const [refId, setRefId] = useState<string>('');
  const [target, setTarget] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [p, setP] = useState<Proposal | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  useEffect(() => { void invoke('claude:status', {}).then((s) => setHasKey(s.hasKey)); if (!brandId) void loadBrands(); }, []);
  useEffect(() => { if (brandId) void lib('swipe.list', brandId).then((r) => setRefs(r.filter((x) => x.analysis))); }, [brandId]);
  const preview = useMemo(() => (p && doc ? compileDirector(doc, p.actions, keep) : null), [p, keep, version]);
  if (!doc) return <div className="empty">Open a project to use the Director.</div>;
  if (hasKey === false) return <div className="col" style={{ padding: 10 }} data-testid="director-panel" data-needs-key="1"><p className="hint">The Edit Director uses Claude with your own API key. It sends the transcript and a text summary of the timeline, never media.</p><button className="primary" onClick={openSettings}>Add API key</button></div>;

  const run = async () => {
    setBusy(true); setError(null); setP(null);
    try {
      const r = await runDirector(goal, { refId: refId || null, targetSec: target === '' ? null : target });
      setP({ summary: r.summary, actions: r.actions, costUsd: r.costUsd, problems: r.plan.problems, baseVersion: version });
      setKeep(new Set(r.plan.ok ? r.actions.map((_, i) => i) : []));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const apply = () => {
    if (!p) return;
    const r = applyDirector(p.actions, keep, p.summary);
    if (!r.ok) { setError(r.problems.map((x) => x.reason).join('; ') || 'Could not apply'); return; }
    toast(`Director: ${keep.size} edit${keep.size === 1 ? '' : 's'} applied${r.removedUs ? `, ${f(r.removedUs)} s shorter` : ''}. One Cmd+Z undoes all of it.`, 'ok');
    setP(null);
  };
  const toggle = (i: number) => setKeep((k) => { const n = new Set(k); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  const stale = p && p.baseVersion !== version;
  return (
    <div className="col scroll" style={{ padding: 10 }} data-testid="director-panel">
      <label className="field">What should the Director do?<textarea rows={3} value={goal} onChange={(e) => setGoal(e.target.value)} aria-label="Director goal" /></label>
      <div className="row">
        <select value={refId} onChange={(e) => setRefId(e.target.value)} aria-label="Match a reference's pacing" style={{ flex: 1 }}>
          <option value="">No reference pacing</option>
          {refs.map((r) => <option key={r.id} value={r.id}>Match: {r.title}</option>)}
        </select>
        <input type="number" min={5} max={600} placeholder="Target s" value={target} onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))} aria-label="Target length in seconds" style={{ width: 90 }} />
      </div>
      <button className="primary" onClick={() => void run()} disabled={busy} data-testid="run-director">{busy ? 'Thinking...' : 'Propose edits'}</button>
      <p className="hint">Sends the transcript and a text summary of the timeline ({f(timelineDuration(doc))} s). Nothing changes until you apply.</p>
      {error && <div className="err" role="alert">{error}</div>}
      {p && (
        <div className="col" data-testid="director-proposal">
          <strong>{p.summary}</strong>
          <span className="hint">${p.costUsd.toFixed(4)}{stale ? ' · the project changed since; edits are re-checked when you apply' : ''}</span>
          {p.problems.length > 0 && <div className="err" role="alert">Claude proposed edits that do not fit this project, so none are selected:<ul>{p.problems.map((x, i) => <li key={i}>{x.reason}</li>)}</ul></div>}
          {p.actions.map((a, i) => {
            const item = preview?.preview.find((x) => x.index === i);
            return (
              <label key={i} className="finding row" style={{ alignItems: 'flex-start' }} data-action={i}>
                <input type="checkbox" checked={keep.has(i)} onChange={() => toggle(i)} aria-label={`Keep edit ${i + 1}`} />
                <span className="col" style={{ gap: 2 }}><span>{item?.label ?? `${a.type} ${a.start.toFixed(2)} to ${a.end.toFixed(2)} s`}</span><span className="hint">{a.reason}</span></span>
              </label>
            );
          })}
          {preview && !preview.ok && keep.size > 0 && <div className="err">{preview.problems.map((x) => x.reason).join('; ')}</div>}
          {preview?.ok && <p className="hint">Result: {f(preview.before)} s to {f(preview.after)} s · {preview.counts.cut} cuts, {preview.counts.zoom} zooms, {preview.counts.broll} b-roll, {preview.counts.text} titles, {preview.counts.marker} notes</p>}
          <div className="row">
            <button className="primary" onClick={apply} disabled={!keep.size || !preview?.ok} data-testid="apply-director">Apply {keep.size} edit{keep.size === 1 ? '' : 's'}</button>
            <button onClick={() => setP(null)}>Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}

registerEditPanel({ id: 'director', label: 'Director', component: DirectorPanel, order: 50 });
registerCommands([{ id: 'edit.director', title: 'Edit Director', group: 'AI', description: 'Claude proposes cuts, zooms, b-roll and titles for you to accept', shortcut: 'Cmd+Shift+E', run: () => { useShell.getState().setWorkspace('edit'); setEdit({ panel: 'director' }); } }]);
(globalThis as Record<string, unknown>).__directorDirector = { runDirector, applyDirector, compileDirector };
