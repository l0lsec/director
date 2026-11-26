import { useEffect, useState } from 'react';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { useAgent } from '../../agent/store';

type Tab = 'claudeCode' | 'claudeDesktop' | 'http' | 'rest';
const TABS: Array<{ id: Tab; label: string; how: string }> = [
  { id: 'claudeCode', label: 'Claude Code', how: 'Run this once in Terminal. Then ask Claude Code to edit your video, for example: "Use Director to tighten the pacing and add captions."' },
  { id: 'claudeDesktop', label: 'Claude Desktop', how: 'In Claude Desktop open Settings, Developer, Edit Config, paste this (merge it into "mcpServers" if you already have servers), save, and restart Claude Desktop.' },
  { id: 'http', label: 'Other MCP apps', how: 'For any app that connects to MCP servers over HTTP (Cursor, VS Code, custom agents).' },
  { id: 'rest', label: 'Any AI (HTTP)', how: 'No MCP? GET /api/tools returns every tool as Anthropic, OpenAI or MCP definitions; POST /api/tools/<name> runs one. Same token.' },
];

/** Clipboard write that also works when the window is not focused (falls back to a selection copy). */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  return ok;
}

/** Settings: let AI assistants control Director, choose how much they may do on their own, and connect them. */
export function McpSettings() {
  const st = useAgent((s) => s.status);
  const toast = useShell((s) => s.toast);
  const [tab, setTab] = useState<Tab>('claudeCode');
  const [show, setShow] = useState(false);
  useEffect(() => { if (!st) void invoke('mcp:status', {}).then((s) => useAgent.setState({ status: s })); }, [st]);
  if (!st) return null;
  const set = async (on: boolean, rotateToken?: boolean) => {
    try { useAgent.setState({ status: await invoke('mcp:enable', { on, rotateToken }) }); if (rotateToken) toast('New token made. Connected apps need the new setup to reconnect.', 'ok'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  const setMode = async (mode: 'ask' | 'auto') => useAgent.setState({ status: await invoke('agent:setMode', { mode }) });
  const snippet = st.setup?.[tab] ?? '';
  const masked = show ? snippet : snippet.replace(st.token ?? '\u0000', '•'.repeat(12));
  const copy = () => void copyText(snippet).then((ok) => toast(ok ? 'Copied. Keep it private: it lets apps on this Mac edit your projects.' : 'Could not copy; select the text and copy it instead.', ok ? 'ok' : 'error'));
  return (
    <section className="col" data-testid="mcp-settings" aria-labelledby="agent-settings-title">
      <h3 id="agent-settings-title" style={{ margin: 0 }}>Connect an AI</h3>
      <p className="hint" style={{ margin: 0 }}>Let Claude (or another AI assistant on this Mac) edit with you: it can read your timeline and transcript, see frames, and use every editing tool. It only listens on this Mac and needs a private token.</p>
      <label className="row">
        <input type="checkbox" checked={st.enabled} onChange={(e) => void set(e.target.checked)} data-testid="mcp-toggle" />
        Allow AI assistants to control Director
        {st.running ? <span className="chip" data-testid="agent-ready">Ready: {st.tools} tools</span> : st.enabled ? <span className="chip">Not running</span> : null}
      </label>
      {st.error && <div className="err" role="alert">{st.error}</div>}
      {st.enabled && (
        <fieldset className="col" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
          <legend className="hint" style={{ padding: 0 }}>When an AI wants to change your project</legend>
          <label className="row"><input type="radio" name="agent-mode" checked={st.mode === 'ask'} onChange={() => void setMode('ask')} data-testid="agent-mode-ask" /> Ask me first (recommended)</label>
          <label className="row"><input type="radio" name="agent-mode" checked={st.mode === 'auto'} onChange={() => void setMode('auto')} data-testid="agent-mode-auto" /> Apply right away (every change stays undoable, and the Agent panel can revert them all)</label>
        </fieldset>
      )}
      {st.running && st.setup && (
        <div className="col" style={{ gap: 6 }}>
          <div role="tablist" aria-label="Connect an app" className="row" style={{ flexWrap: 'wrap' }}>
            {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'chip on' : 'chip'} onClick={() => setTab(t.id)} data-testid={`setup-tab-${t.id}`}>{t.label}</button>)}
          </div>
          <p className="hint" style={{ margin: 0 }}>{TABS.find((t) => t.id === tab)!.how}</p>
          <pre className="sc-stream" style={{ userSelect: 'text', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0 }} data-testid={`setup-${tab}`} data-snippet={snippet} aria-label={`${TABS.find((t) => t.id === tab)!.label} setup`}>{masked}</pre>
          <div className="row">
            <button className="primary mini" onClick={copy} data-testid="setup-copy">Copy</button>
            <button className="mini" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide token' : 'Show token'}</button>
            <button className="mini" onClick={() => void set(true, true)} title="Disconnects every app until it gets the new setup">New token</button>
          </div>
        </div>
      )}
    </section>
  );
}
