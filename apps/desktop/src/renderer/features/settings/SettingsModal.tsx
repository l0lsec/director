import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { invoke, onEvent } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { registerCommands } from '../palette/registry';
import { McpSettings } from './mcp/McpSettings';

const useSettingsUi = create<{ open: boolean }>(() => ({ open: false }));
export const openSettings = () => useSettingsUi.setState({ open: true });

type Status = Awaited<ReturnType<typeof invoke<'claude:status'>>>;

function ClaudeSettings() {
  const toast = useShell((s) => s.toast);
  const [st, setSt] = useState<Status | null>(null);
  const [key, setKey] = useState('');
  const refresh = () => void invoke('claude:status', {}).then(setSt);
  useEffect(() => { refresh(); return onEvent('claude:usage', refresh); }, []);
  if (!st) return null;
  const saveKey = async (k: string | null) => {
    try { await invoke('claude:setKey', { key: k }); setKey(''); refresh(); toast(k ? 'API key saved to the macOS Keychain' : 'API key removed', 'ok'); } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <section className="col" data-testid="claude-settings">
      <h3 style={{ margin: 0 }}>Claude</h3>
      <p className="hint">Optional. Your own API key, billed per use by Anthropic. Only text leaves your Mac (transcripts, scripts, timings); never video, audio or file paths.</p>
      {st.hasKey ? (
        <div className="row"><span className="chip">Key saved</span><button className="mini" onClick={() => void saveKey(null)}>Remove key</button></div>
      ) : (
        <form className="row" onSubmit={(e) => { e.preventDefault(); void saveKey(key); }}>
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-..." aria-label="Claude API key" style={{ flex: 1 }} autoComplete="off" />
          <button className="primary" disabled={!key.trim()}>Save key</button>
        </form>
      )}
      <label className="row">Model
        <select value={st.model} onChange={(e) => void invoke('claude:setModel', { model: e.target.value }).then(refresh)} aria-label="Claude model">
          {st.models.map((m) => <option key={m.id} value={m.id}>{m.label} (${m.input} in / ${m.output} out per million tokens)</option>)}
        </select>
      </label>
      <div className="col" data-testid="usage-meter">
        <strong>This month: ${st.usage.costUsd.toFixed(st.usage.costUsd < 1 ? 4 : 2)} over {st.usage.calls} call{st.usage.calls === 1 ? '' : 's'}</strong>
        {st.usage.byTask.map((t) => <span key={t.task} className="hint">{t.task}: {t.calls} call{t.calls === 1 ? '' : 's'}, ${t.costUsd.toFixed(4)}</span>)}
      </div>
    </section>
  );
}

type ModelRow = Awaited<ReturnType<typeof invoke<'models:list'>>>[number];
/** The order transcription prefers installed models in (see main/transcribe/models.ts findModel). */
const PREFERENCE = ['large-v3-turbo', 'small.en', 'base.en'];

function TranscriptionSettings() {
  const toast = useShell((s) => s.toast);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [progress, setProgress] = useState<Record<string, { got: number; total: number | null }>>({});
  const refresh = () => void invoke('models:list', {}).then(setModels);
  useEffect(() => { refresh(); return onEvent('models:progress', (p) => setProgress((x) => ({ ...x, [p.id]: { got: p.got, total: p.total } }))); }, []);
  if (!models) return null;
  const inUse = PREFERENCE.find((id) => models.some((m) => m.id === id && m.path));
  const download = async (m: ModelRow) => {
    setProgress((x) => ({ ...x, [m.id]: { got: 0, total: m.sizeMB * 1e6 } }));
    try { await invoke('models:download', { id: m.id }); toast(`${m.label} downloaded and verified`, 'ok'); }
    catch (e) { if (/cancelled/.test((e as Error).message)) toast(`${m.label} paused; Download picks up where it stopped`, 'info'); else toast((e as Error).message, 'error'); }
    finally { setProgress((x) => { const { [m.id]: _done, ...rest } = x; return rest; }); refresh(); }
  };
  return (
    <section className="col" data-testid="transcription-settings">
      <h3 style={{ margin: 0 }}>Transcription</h3>
      <p className="hint">Speech to text runs on this Mac with whisper.cpp. Director uses the best model installed{inUse ? '' : '; download one to transcribe'}. Downloads come from Hugging Face and are checked against their published checksum.</p>
      {[...models].sort((a, b) => PREFERENCE.indexOf(a.id) - PREFERENCE.indexOf(b.id)).map((m) => {
        const p = progress[m.id];
        const pct = p && p.total ? Math.min(100, Math.round((p.got / p.total) * 100)) : null;
        return (
          <div key={m.id} className="row" data-testid={`model-${m.id}`} style={{ justifyContent: 'space-between' }}>
            <span>{m.label} <span className="hint">({m.sizeMB >= 1000 ? `${(m.sizeMB / 1000).toFixed(1)} GB` : `${m.sizeMB} MB`})</span></span>
            {m.path ? <span className="chip">{m.id === inUse ? 'Installed, in use' : 'Installed'}</span>
              : p ? <span className="row"><progress max={100} value={pct ?? undefined} aria-label={`Downloading ${m.label}`} /><button className="mini" onClick={() => void invoke('models:cancel', { id: m.id })}>Cancel</button></span>
              : <button className="mini" onClick={() => void download(m)}>Download</button>}
          </div>
        );
      })}
    </section>
  );
}

export function SettingsModal() {
  const open = useSettingsUi((s) => s.open);
  const close = () => useSettingsUi.setState({ open: false });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal col" role="dialog" aria-modal="true" aria-label="Settings" data-testid="settings" style={{ gap: 16, width: 620 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}><h2 style={{ margin: 0 }}>Settings</h2><button onClick={close} aria-label="Close settings">Close</button></div>
        <TranscriptionSettings />
        <ClaudeSettings />
        <McpSettings />
      </div>
    </div>
  );
}

registerCommands([{ id: 'settings.open', title: 'Settings', group: 'App', description: 'Transcription models, Claude API key and usage, and connecting an AI', shortcut: 'Cmd+,', run: openSettings }]);
