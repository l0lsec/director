import { useEffect, useRef, useState } from 'react';
import { invoke } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { useProject } from '../project/store';
import { registerEditPanel } from '../edit/panels';
import { setEdit } from '../edit/store';
import { registerCommands } from '../palette/registry';
import { openSettings } from '../settings/SettingsModal';
import { useAgent } from '../agent/store';
import { useAssistant, send, stop, newChat, type ChatItem } from './session';
import './assistant.css';

const SUGGESTIONS = [
  'Remove the long pauses and filler words',
  'Cut to whoever is talking, with both people during quick exchanges',
  'Add bold captions to the whole video',
  'Add chapter markers and export the YouTube chapters',
];

const TOOL_STATUS: Record<string, string> = { running: 'Working', done: 'Done', applied: 'Changed', rejected: 'Rejected', error: 'Failed' };

function Item({ it }: { it: ChatItem }) {
  if (it.kind === 'tool') {
    return (
      <li className="asst-tool" data-status={it.status} data-tool={it.tool}>
        <span className={`asst-dot ${it.status ?? ''}`} aria-hidden="true" />
        <span className="asst-tool-text">{it.text}</span>
        <span className="hint">{TOOL_STATUS[it.status ?? 'done']}</span>
      </li>
    );
  }
  return <li className={`asst-msg ${it.kind}`} data-kind={it.kind} role={it.kind === 'error' ? 'alert' : undefined}>{it.text}</li>;
}

/** A chat with Claude that edits the open project with every agent tool, one undoable change at a time. */
export function AssistantPanel() {
  const doc = useProject((s) => s.doc);
  const items = useAssistant((s) => s.items);
  const busy = useAssistant((s) => s.busy);
  const streaming = useAssistant((s) => s.streaming);
  const cost = useAssistant((s) => s.costUsd);
  const draft = useAssistant((s) => s.draft);
  const focusTick = useAssistant((s) => s.focusTick);
  const mode = useAgent((s) => s.status?.mode ?? 'ask');
  const waiting = useAgent((s) => s.queue.some((q) => q.client === 'Assistant'));
  const toast = useShell((s) => s.toast);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { void invoke('claude:status', {}).then((s) => setHasKey(s.hasKey)); }, []);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [items.length, streaming]);
  useEffect(() => { input.current?.focus(); }, [focusTick, hasKey]);

  const setDraft = (d: string) => useAssistant.setState({ draft: d });
  const submit = (text = draft) => { if (text.trim() && !busy) void send(text); };
  const toggleMode = async () => {
    const s = await invoke('agent:setMode', { mode: mode === 'ask' ? 'auto' : 'ask' });
    useAgent.setState({ status: s });
    toast(s.mode === 'auto' ? 'The assistant now applies changes right away. Each one is still a single undo step.' : 'The assistant now asks before each change.', 'info');
  };

  if (hasKey === false) {
    return (
      <div className="col" style={{ padding: 10 }} data-testid="assistant-panel" data-needs-key="1">
        <p className="hint">The assistant uses Claude with your own API key. It sends your messages, the transcript and a text description of the timeline. Pictures, file paths and file names stay on this Mac.</p>
        <button className="primary" onClick={openSettings}>Add API key</button>
      </div>
    );
  }

  return (
    <div className="asst" data-testid="assistant-panel" data-busy={busy ? '1' : '0'}>
      <div className="row asst-head">
        <button className="mini" onClick={() => void toggleMode()} data-testid="assistant-mode" title="Switch between asking before each change and applying right away">
          {mode === 'ask' ? 'Asks before changes' : 'Applies right away'}
        </button>
        <span className="hint" data-testid="assistant-cost">{cost > 0 ? `$${cost.toFixed(2)}` : ''}</span>
        <button className="mini" onClick={newChat} disabled={busy || !items.length} data-testid="assistant-new">New chat</button>
      </div>
      <ol className="asst-log scroll" ref={list} aria-label="Assistant conversation" aria-live="polite" data-testid="assistant-log">
        {!items.length && (
          <li className="asst-empty">
            <p className="hint">{doc ? 'Tell Claude what to do with this project, in your own words. It reads the timeline and transcript, makes the edits, and tells you what changed.' : 'Open a project, then tell Claude what to do with it.'}</p>
            {doc && (
              <div className="col" style={{ gap: 6 }}>
                {SUGGESTIONS.map((s) => <button key={s} className="asst-suggest" onClick={() => submit(s)} disabled={busy}>{s}</button>)}
              </div>
            )}
          </li>
        )}
        {items.map((it) => <Item key={it.id} it={it} />)}
        {busy && streaming && <li className="asst-msg assistant streaming">{streaming}</li>}
        {busy && !streaming && <li className="asst-msg note">{waiting ? 'Waiting for you to accept or reject the change.' : 'Working...'}</li>}
      </ol>
      <form className="asst-compose" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <textarea
          ref={input}
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          placeholder={busy ? 'Claude is working...' : 'Ask for an edit, e.g. "tighten 12:00 to 15:00 and add a title over the hook"'}
          aria-label="Message the assistant"
          data-testid="assistant-input"
        />
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="hint">Enter sends, Shift+Enter adds a line. Every change is one undo step.</span>
          {busy
            ? <button type="button" onClick={stop} data-testid="assistant-stop">Stop</button>
            : <button type="submit" className="primary" disabled={!draft.trim()} data-testid="assistant-send">Send</button>}
        </div>
      </form>
    </div>
  );
}

registerEditPanel({ id: 'assistant', label: 'Assistant', component: AssistantPanel, order: 55 });
registerCommands([{
  id: 'assistant.open', title: 'Ask the assistant', group: 'AI', shortcut: 'Cmd+J',
  description: 'Chat with Claude, which edits the project for you with every editing tool',
  run: () => { useShell.getState().setWorkspace('edit'); setEdit({ panel: 'assistant' }); useAssistant.setState((s) => ({ focusTick: s.focusTick + 1 })); },
}]);
