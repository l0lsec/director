import { useState } from 'react';
import { registerEditPanel } from '../edit/panels';
import { useShell } from '../../shell/store';
import { useAgent } from './store';
import { revertAgentChanges } from './host';

const STATUS: Record<string, string> = { running: 'Working', waiting: 'Waiting for you', applied: 'Changed', done: 'Done', rejected: 'Rejected', error: 'Failed' };

/** Everything AI assistants did, live, with one button to take all their changes back. */
export function AgentPanel() {
  const st = useAgent((s) => s.status);
  const activity = useAgent((s) => s.activity);
  const [showReads, setShowReads] = useState(false);
  const toast = useShell((s) => s.toast);
  const list = activity.filter((a) => showReads || a.kind !== 'read' || a.status === 'error');
  const changed = activity.filter((a) => a.status === 'applied').length;
  const revert = () => {
    try { const r = revertAgentChanges(); toast(r.reverted ? `Reverted ${r.reverted} agent change${r.reverted > 1 ? 's' : ''} (undo brings them back)` : 'No agent changes to revert', 'ok'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="col" style={{ padding: 10, gap: 8, minHeight: 0, flex: 1 }} data-testid="agent-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>AI assistants</strong>
        <span className="chip" data-testid="agent-panel-status">{!st?.enabled ? 'Off' : !st.running ? 'Not running' : st.mode === 'ask' ? 'Asks first' : 'Applies right away'}</span>
      </div>
      {!st?.enabled && <p className="hint" style={{ margin: 0 }}>Turn on "Connect an AI" in Settings (Cmd+,) to let Claude edit with you.</p>}
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="mini" onClick={revert} disabled={!changed} data-testid="agent-revert">Revert agent changes</button>
        <label className="row hint"><input type="checkbox" checked={showReads} onChange={(e) => setShowReads(e.target.checked)} /> Show reads</label>
      </div>
      <ol className="scroll" style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }} aria-label="Agent activity" data-testid="agent-activity">
        {list.map((a) => (
          <li key={a.id} className="cutrow" data-status={a.status} data-tool={a.tool} style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 2 }}>
            <span className="row" style={{ gap: 6 }}><strong>{a.client}</strong><span className="hint">{a.tool}</span><span className={`chip ${a.status === 'error' || a.status === 'rejected' ? 'warn' : ''}`}>{STATUS[a.status]}</span></span>
            <span>{a.summary}</span>
            <span className="hint">{new Date(a.at).toLocaleTimeString()}{a.ms != null ? ` · ${a.ms < 1000 ? `${a.ms} ms` : `${(a.ms / 1000).toFixed(1)} s`}` : ''}</span>
          </li>
        ))}
        {!list.length && <li className="empty">Nothing yet. What assistants read and change shows up here.</li>}
      </ol>
    </div>
  );
}

registerEditPanel({ id: 'agent', label: 'Agent', component: AgentPanel, order: 60 });
