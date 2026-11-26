import { useShell } from '../../shell/store';
import { setEdit } from '../edit/store';
import { useAgent } from './store';

/** Top-bar chip: whether AI assistants are connected, how they work, and what waits for you. */
export function AgentStatus() {
  const st = useAgent((s) => s.status);
  const waiting = useAgent((s) => s.queue.length);
  const busy = useAgent((s) => s.activity.some((a) => a.status === 'running' || a.status === 'waiting'));
  if (!st?.enabled) return null;
  const label = !st.running ? 'AI: not running' : waiting ? `AI: ${waiting} waiting for you` : `AI: ${st.mode === 'ask' ? 'asks first' : 'auto'}${busy ? ', working' : ''}`;
  const open = () => { useShell.getState().setWorkspace('edit'); setEdit({ panel: 'agent' }); };
  return (
    <button className={`mini chip${waiting ? ' on' : ''}`} onClick={open} data-testid="agent-status" aria-live="polite" title="Open the Agent panel: what AI assistants did, and revert" style={{ marginLeft: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {label}
    </button>
  );
}
