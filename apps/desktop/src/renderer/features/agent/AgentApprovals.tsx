import { useEffect } from 'react';
import { invoke } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { useAgent } from './store';

/** One pending agent change at a time: what it is, who asks, Accept or Reject. Nothing changes until Accept. */
export function AgentApprovals() {
  const p = useAgent((s) => s.queue[0]);
  const more = useAgent((s) => s.queue.length - 1);
  useEffect(() => {
    if (!p) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); p.resolve({ ok: false }); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [p]);
  if (!p) return null;
  const acceptAll = async () => {
    p.resolve({ ok: true });
    const s = await invoke('agent:setMode', { mode: 'auto' });
    useAgent.setState({ status: s });
    for (const q of useAgent.getState().queue) if (!q.alwaysAsk) q.resolve({ ok: true });
    useShell.getState().toast('Agents now apply changes without asking. Every change is still undoable; switch back in Settings.', 'info');
  };
  return (
    <div className="modal-backdrop">
      <div className="modal col" role="dialog" aria-modal="true" aria-labelledby="agent-approval-title" data-testid="mcp-proposal" data-proposal={p.id} data-tool={p.tool}>
        <strong id="agent-approval-title">{p.client} wants to {p.kind === 'edit' ? 'change your project' : 'do something'}</strong>
        <p style={{ margin: 0 }} data-testid="agent-approval-summary">{p.summary}</p>
        {p.preview.length > 0 && <ul className="hint" style={{ margin: 0, paddingLeft: 18, maxHeight: 260, overflow: 'auto' }}>{p.preview.map((l, i) => <li key={i}>{l}</li>)}</ul>}
        <p className="hint">Nothing has changed yet. {p.kind === 'edit' ? 'Accept applies it as one undo step.' : 'Accept lets it run.'}{more > 0 ? ` ${more} more waiting.` : ''}</p>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          {p.alwaysAsk ? <span /> : <button className="mini" onClick={() => void acceptAll()} data-testid="mcp-accept-all" title="Switch to Apply automatically: agents stop asking (all changes stay undoable)">Accept and stop asking</button>}
          <div className="row">
            <button onClick={() => p.resolve({ ok: false })} data-testid="mcp-reject">Reject</button>
            <button className="primary" autoFocus onClick={() => p.resolve({ ok: true })} data-testid="mcp-accept">Accept</button>
          </div>
        </div>
      </div>
    </div>
  );
}
