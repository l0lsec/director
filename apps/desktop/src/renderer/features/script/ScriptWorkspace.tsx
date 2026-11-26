import { useEffect, useMemo, useRef, useState } from 'react';
import './script.css';
import { parseScript, estimateSeconds, timelineDuration } from '@director/engine';
import { timelineWords } from '@director/analysis';
import type { Script, ScriptVersion, VoiceProfile, Hook, Reference } from '@director/library';
import type { HookIdea, VoiceCheck, ReleaseCopy } from '@director/ai';
import { invoke, onEvent } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { lib, useBrand, loadBrands, libraryChanged } from '../../shell/library';
import { ask } from '../../shell/prompt';
import { useProject } from '../project/store';
import { registerCommands } from '../palette/registry';
import { useScriptUi, sendToPrompter, type AiTab } from './scriptStore';
import { openSettings } from '../settings/SettingsModal';

const secs = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function useClaudeReady(): boolean | null {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => { void invoke('claude:status', {}).then((s) => setOk(s.hasKey)); }, []);
  return ok;
}

function NeedsKey() {
  return <div className="col"><p className="hint">Claude features use your own API key and cost a few cents per run. Only text (scripts, transcripts, timings) is sent.</p><button className="primary" onClick={() => openSettings()}>Add API key</button></div>;
}

function VoiceEditor({ brandId, v, onDone }: { brandId: string; v: VoiceProfile | null; onDone: () => void }) {
  const toast = useShell((s) => s.toast);
  const [f, setF] = useState({ name: v?.name ?? '', description: v?.description ?? '', rules: v?.rules.join('\n') ?? '', examples: v?.examples.join('\n---\n') ?? '', banned: v?.banned.join(', ') ?? '', wpm: v?.wpm ?? 160 });
  const save = async () => {
    const body = { name: f.name, description: f.description, rules: f.rules.split('\n'), examples: f.examples.split(/\n-{3,}\n/), banned: f.banned.split(','), wpm: Number(f.wpm) };
    try {
      if (v) await lib('studio.updateVoice', brandId, v.id, body); else await lib('studio.createVoice', brandId, body);
      libraryChanged(); onDone();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  return (
    <div className="col voice-editor" data-testid="voice-editor">
      <label className="field">Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Voice name" /></label>
      <label className="field">Description<textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Who you talk to and how you sound" /></label>
      <label className="field">Rules (one per line)<textarea rows={3} value={f.rules} onChange={(e) => setF({ ...f, rules: e.target.value })} placeholder={'Short sentences\nSay you, not people'} /></label>
      <label className="field">Examples of your voice (separate with ---)<textarea rows={4} value={f.examples} onChange={(e) => setF({ ...f, examples: e.target.value })} /></label>
      <label className="field">Never say (comma separated)<input value={f.banned} onChange={(e) => setF({ ...f, banned: e.target.value })} placeholder="synergy, leverage" /></label>
      <label className="field">Speaking rate (words per minute)<input type="number" min={60} max={320} value={f.wpm} onChange={(e) => setF({ ...f, wpm: Number(e.target.value) })} /></label>
      <div className="row"><button className="primary" onClick={() => void save()} disabled={!f.name.trim()}>Save voice</button><button onClick={onDone}>Cancel</button></div>
    </div>
  );
}

function LeftPane({ brandId, scripts, voices, hooks, onInsertHook }: { brandId: string; scripts: Script[]; voices: VoiceProfile[]; hooks: Hook[]; onInsertHook: (t: string) => void }) {
  const { scriptId } = useScriptUi();
  const toast = useShell((s) => s.toast);
  const [tab, setTab] = useState<'scripts' | 'voices' | 'hooks'>('scripts');
  const [editing, setEditing] = useState<VoiceProfile | 'new' | null>(null);
  const newScript = async () => {
    const title = await ask({ title: 'New script', label: 'Working title', confirm: 'Create' });
    if (!title) return;
    const s = await lib('studio.createScript', brandId, { title, text: '', wpm: voices[0]?.wpm ?? 160, voiceId: useScriptUi.getState().voiceId });
    libraryChanged(); useScriptUi.setState({ scriptId: s.id });
  };
  const addHook = async () => {
    const text = await ask({ title: 'Add a hook', label: 'An opening line that worked for you', confirm: 'Add' });
    if (text) { try { await lib('studio.addHook', brandId, { text }); libraryChanged(); } catch (e) { toast((e as Error).message, 'error'); } }
  };
  return (
    <aside className="panel sc-left">
      <div className="tabs" role="tablist">
        {(['scripts', 'voices', 'hooks'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
      </div>
      {tab === 'scripts' && (
        <div className="col scroll" style={{ padding: 8 }}>
          <button className="primary" onClick={() => void newScript()} data-testid="new-script">New script</button>
          {scripts.map((s) => (
            <button key={s.id} className={`sc-item${s.id === scriptId ? ' on' : ''}`} onClick={() => useScriptUi.setState({ scriptId: s.id })} data-script={s.id}>
              <strong>{s.title}</strong><span className="hint">v{s.current.n} · {secs(estimateSeconds(parseScript(s.current.text), s.current.wpm))}{s.current.targetSec ? ` of ${secs(s.current.targetSec)}` : ''}</span>
            </button>
          ))}
          {!scripts.length && <p className="hint">No scripts yet. Write one, or draft one from a reference in Swipe.</p>}
        </div>
      )}
      {tab === 'voices' && (
        <div className="col scroll" style={{ padding: 8 }}>
          {editing ? <VoiceEditor brandId={brandId} v={editing === 'new' ? null : editing} onDone={() => setEditing(null)} /> : (
            <>
              <button onClick={() => setEditing('new')} data-testid="new-voice">New voice profile</button>
              {voices.map((v) => (
                <div key={v.id} className="sc-item">
                  <strong>{v.name}</strong><span className="hint">{v.wpm} wpm · {v.rules.length} rules{v.banned.length ? ` · ${v.banned.length} banned` : ''}</span>
                  <div className="row"><button className="mini" onClick={() => setEditing(v)}>Edit</button><button className="mini" onClick={() => void lib('studio.deleteVoice', brandId, v.id).then(() => { libraryChanged(); toast(`Deleted "${v.name}"`, 'info'); })}>Delete</button></div>
                </div>
              ))}
              {!voices.length && <p className="hint">A voice profile teaches Claude how you sound: rules, examples and words you never use.</p>}
            </>
          )}
        </div>
      )}
      {tab === 'hooks' && (
        <div className="col scroll" style={{ padding: 8 }}>
          <button onClick={() => void addHook()}>Add a hook</button>
          {hooks.map((h) => (
            <div key={h.id} className="sc-item" data-hook={h.id}>
              <span>{h.text}</span>
              <span className="hint">{h.score != null ? `${h.score.toFixed(1)} · ` : ''}{h.tags.map((t) => `#${t}`).join(' ')}{h.used ? ` · used ${h.used}x` : ''}</span>
              <div className="row"><button className="mini" onClick={() => { onInsertHook(h.text); void lib('studio.markHookUsed', brandId, h.id).then(libraryChanged); }}>Use</button><button className="mini" onClick={() => void lib('studio.deleteHook', brandId, h.id).then(libraryChanged)}>Delete</button></div>
            </div>
          ))}
          {!hooks.length && <p className="hint">Save hooks that worked, or generate some with Claude.</p>}
        </div>
      )}
    </aside>
  );
}

function Editor({ brandId, script, voices, onChange, text, onRestored }: { brandId: string; script: Script | null; voices: VoiceProfile[]; text: string; onChange: (t: string) => void; onRestored: () => void }) {
  const toast = useShell((s) => s.toast);
  const [versions, setVersions] = useState<ScriptVersion[]>([]);
  const [title, setTitle] = useState(script?.title ?? '');
  const [wpm, setWpm] = useState(script?.current.wpm ?? 160);
  const [target, setTarget] = useState<number | ''>(script?.current.targetSec ?? '');
  useEffect(() => { setTitle(script?.title ?? ''); setWpm(script?.current.wpm ?? 160); setTarget(script?.current.targetSec ?? ''); if (script) void lib('studio.versions', brandId, script.id).then(setVersions); }, [script?.id, script?.current.n]);
  const parsed = useMemo(() => parseScript(text), [text]);
  const est = estimateSeconds(parsed, wpm);
  if (!script) return <section className="panel sc-center"><div className="empty">Pick a script on the left or create one.</div></section>;
  const dirty = text !== script.current.text || wpm !== script.current.wpm || (target === '' ? null : target) !== script.current.targetSec || title !== script.title;
  const save = async (note?: string) => {
    try {
      await lib('studio.saveVersion', brandId, script.id, { text, wpm, targetSec: target === '' ? null : target, title, note });
      libraryChanged();
    } catch (e) { toast((e as Error).message, 'error'); }
  };
  const off = typeof target === 'number' && target > 0 ? (est - target) / target : null;
  return (
    <section className="panel sc-center" data-testid="script-editor">
      <div className="row sc-head">
        <input className="sc-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Script title" />
        <select value={script.current.n} onChange={(e) => { const n = Number(e.target.value); if (n !== script.current.n) void lib('studio.restoreVersion', brandId, script.id, n).then(() => { onRestored(); libraryChanged(); toast(`Restored v${n} as a new version`, 'ok'); }); }} aria-label="Version history">
          {[...versions].reverse().map((v) => <option key={v.id} value={v.n}>v{v.n} · {v.note} · {new Date(v.created).toLocaleString()}</option>)}
        </select>
      </div>
      <textarea className="sc-text" value={text} onChange={(e) => onChange(e.target.value)} aria-label="Script text" data-testid="script-text" spellCheck placeholder={'[HOOK] Your opening line.\nOne beat per line.\n[ZOOM] Cues in brackets are not read aloud.'} />
      <div className="row sc-foot">
        <span className={`chip${off != null && Math.abs(off) > 0.1 ? ' warn' : ''}`} data-testid="runtime">{secs(est)} at {wpm} wpm · {parsed.wordCount} words · {parsed.cues.length} cues</span>
        <label className="row">Target<input type="number" min={5} max={600} value={target} onChange={(e) => setTarget(e.target.value === '' ? '' : Number(e.target.value))} style={{ width: 70 }} aria-label="Target seconds" />s</label>
        <label className="row">WPM<input type="number" min={60} max={320} value={wpm} onChange={(e) => setWpm(Number(e.target.value))} style={{ width: 70 }} aria-label="Words per minute" /></label>
        {voices.length > 0 && <select aria-label="Use voice rate" value="" onChange={(e) => { const v = voices.find((x) => x.id === e.target.value); if (v) setWpm(v.wpm); }}><option value="">Rate from voice...</option>{voices.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.wpm})</option>)}</select>}
        <span className="spacer" />
        <button onClick={() => void save()} disabled={!dirty} data-testid="save-version">{dirty ? 'Save version' : 'Saved'}</button>
        <button className="primary" onClick={() => void (async () => { if (dirty) await save('sent to prompter'); await sendToPrompter(script.id); })()} data-testid="send-to-prompter" disabled={!parsed.wordCount}>Send to prompter</button>
        <button className="danger mini" onClick={() => void lib('studio.deleteScript', brandId, script.id).then(() => { useScriptUi.setState({ scriptId: null }); libraryChanged(); toast(`Deleted "${script.title}"`, 'info'); })}>Delete</button>
      </div>
    </section>
  );
}

function DraftTab({ brandId, voices, refs }: { brandId: string; voices: VoiceProfile[]; refs: Reference[] }) {
  const { draftRefId, voiceId } = useScriptUi();
  const toast = useShell((s) => s.toast);
  const [topic, setTopic] = useState('');
  const [target, setTarget] = useState(30);
  const [extra, setExtra] = useState('');
  const [stream, setStream] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ title: string; script: string; notes: string; estimateSec: number; withinTolerance: boolean; revisions: number; costUsd: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reqRef = useRef('');
  useEffect(() => onEvent('claude:text', (e) => { if (e.requestId === reqRef.current) setStream((s) => s + e.delta); }), []);
  const run = async () => {
    const requestId = `draft-${Date.now()}`;
    reqRef.current = requestId;
    setBusy(true); setStream(''); setResult(null); setError(null);
    try {
      const r = await invoke('claude:draft', { brandId, voiceId, topic, targetSec: target, refId: draftRefId, extra: extra || undefined, requestId });
      setResult({ ...r.draft, estimateSec: r.estimateSec, withinTolerance: r.withinTolerance, revisions: r.revisions, costUsd: r.costUsd });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const keep = async () => {
    if (!result) return;
    const v = voices.find((x) => x.id === voiceId);
    const s = await lib('studio.createScript', brandId, { title: result.title, text: result.script, wpm: v?.wpm ?? 160, targetSec: target, voiceId, refId: draftRefId, note: 'drafted with Claude' });
    libraryChanged(); useScriptUi.setState({ scriptId: s.id }); toast(`Saved "${s.title}"`, 'ok');
  };
  return (
    <div className="col" data-testid="draft-tab">
      <label className="field">Reference<select value={draftRefId ?? ''} onChange={(e) => useScriptUi.setState({ draftRefId: e.target.value || null })} aria-label="Reference">
        <option value="">No reference</option>
        {refs.map((r) => <option key={r.id} value={r.id}>{r.title}{(r.analysis as { structure?: unknown } | null)?.structure ? '' : ' (not labelled)'}</option>)}
      </select></label>
      <label className="field">Voice<select value={voiceId ?? ''} onChange={(e) => useScriptUi.setState({ voiceId: e.target.value || null })} aria-label="Voice"><option value="">Default voice</option>{voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      <label className="field">Your topic<textarea rows={2} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is your version about?" aria-label="Topic" /></label>
      <label className="field">Length (seconds)<input type="number" min={5} max={600} value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Length in seconds" /></label>
      <label className="field">Notes (optional)<input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Mention the free guide, keep it upbeat" /></label>
      <button className="primary" disabled={busy || !topic.trim()} onClick={() => void run()} data-testid="run-draft">{busy ? 'Writing...' : 'Draft script'}</button>
      {error && <div className="err" role="alert">{error}</div>}
      {busy && stream && <pre className="sc-stream">{stream}</pre>}
      {result && (
        <div className="col">
          <strong>{result.title}</strong>
          <pre className="sc-stream">{result.script}</pre>
          <p className="hint">{secs(result.estimateSec)} at your rate{result.withinTolerance ? ' (on target)' : ' (still off target: edit by hand)'}{result.revisions ? `, ${result.revisions} revision` : ''} · ${result.costUsd.toFixed(4)}. {result.notes}</p>
          <button className="primary" onClick={() => void keep()} data-testid="keep-draft">Save as script</button>
        </div>
      )}
    </div>
  );
}

function VoiceTab({ brandId, voices, text, onChange }: { brandId: string; voices: VoiceProfile[]; text: string; onChange: (t: string) => void }) {
  const { voiceId } = useScriptUi();
  const [busy, setBusy] = useState(false);
  const [check, setCheck] = useState<VoiceCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const v = voices.find((x) => x.id === voiceId) ?? voices[0];
  const run = async () => {
    if (!v) return;
    setBusy(true); setError(null);
    try { setCheck((await invoke('claude:voiceCheck', { brandId, voiceId: v.id, script: text })).check); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const applyLine = (n: number, replacement: string) => {
    const ls = lines(text);
    ls[n - 1] = replacement;
    onChange(ls.join('\n'));
  };
  if (!voices.length) return <p className="hint">Create a voice profile (left, Voices) to check scripts against it.</p>;
  return (
    <div className="col" data-testid="voice-tab">
      <label className="field">Voice<select value={v?.id} onChange={(e) => useScriptUi.setState({ voiceId: e.target.value })} aria-label="Voice to check against">{voices.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
      <button className="primary" disabled={busy || !text.trim()} onClick={() => void run()}>{busy ? 'Checking...' : 'Check against voice'}</button>
      {error && <div className="err" role="alert">{error}</div>}
      {check && (
        <>
          <p className="hint">Match {check.score.toFixed(1)} / 10{check.dropped ? ` · ${check.dropped} finding(s) ignored (pointed at no line)` : ''}</p>
          {check.findings.map((f, i) => (
            <div key={i} className={`finding ${f.severity}`} data-line={f.line}>
              <span className="hint">Line {f.line}: {f.text}</span>
              <span>{f.issue}</span>
              {f.suggestion && <div className="row"><em>{f.suggestion}</em><button className="mini" onClick={() => applyLine(f.line, f.suggestion)}>Apply</button></div>}
            </div>
          ))}
          {check.rewrite && <button onClick={() => onChange(check.rewrite)}>Use the full rewrite</button>}
        </>
      )}
    </div>
  );
}

function HooksTab({ brandId, onInsert }: { brandId: string; onInsert: (t: string) => void }) {
  const { voiceId } = useScriptUi();
  const toast = useShell((s) => s.toast);
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [hooks, setHooks] = useState<HookIdea[]>([]);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setError(null);
    try { setHooks((await invoke('claude:hooks', { brandId, voiceId, topic })).hooks); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="col" data-testid="hooks-tab">
      <label className="field">Topic<input value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Hook topic" /></label>
      <button className="primary" disabled={busy || !topic.trim()} onClick={() => void run()}>{busy ? 'Writing...' : 'Write 10 hooks'}</button>
      {error && <div className="err" role="alert">{error}</div>}
      {hooks.map((h) => (
        <div key={h.text} className="finding">
          <span>{h.text}</span><span className="hint">{h.score.toFixed(1)} · {h.tags.map((t) => `#${t}`).join(' ')} · {h.why}</span>
          <div className="row"><button className="mini" onClick={() => onInsert(h.text)}>Use</button><button className="mini" onClick={() => void lib('studio.addHook', brandId, { text: h.text, tags: h.tags, score: h.score, source: 'claude' }).then(() => { libraryChanged(); toast('Saved to the hook bank', 'ok'); })}>Save</button></div>
        </div>
      ))}
    </div>
  );
}

function CopyTab({ brandId }: { brandId: string }) {
  const { voiceId } = useScriptUi();
  const doc = useProject((s) => s.doc);
  const [busy, setBusy] = useState(false);
  const [copy, setCopy] = useState<ReleaseCopy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcript = doc ? timelineWords(doc).map((w) => w.text).join(' ') : '';
  const run = async () => {
    setBusy(true); setError(null);
    try { setCopy((await invoke('claude:release', { brandId, voiceId, transcript })).copy); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const clip = (t: string) => void navigator.clipboard.writeText(t).then(() => useShell.getState().toast('Copied', 'ok'));
  return (
    <div className="col">
      <p className="hint">Captions, hashtags and cover text for the open edit ({doc ? secs(timelineDuration(doc) / 1e6) : 'no project'}), from its transcript.</p>
      <button className="primary" disabled={busy || !transcript} onClick={() => void run()}>{busy ? 'Writing...' : 'Write post copy'}</button>
      {error && <div className="err" role="alert">{error}</div>}
      {copy && (
        <>
          {copy.captions.map((c) => <div key={c} className="finding"><span>{c}</span><button className="mini" onClick={() => clip(c)}>Copy</button></div>)}
          <div className="finding"><span>{copy.hashtags.map((h) => `#${h}`).join(' ')}</span><button className="mini" onClick={() => clip(copy.hashtags.map((h) => `#${h}`).join(' '))}>Copy</button></div>
          <div className="tagrow">{copy.covers.map((c) => <span key={c} className="chip">{c}</span>)}</div>
        </>
      )}
    </div>
  );
}

export default function ScriptWorkspace() {
  const { activeId: brandId, version } = useBrand();
  const { scriptId, aiTab } = useScriptUi();
  const [scripts, setScripts] = useState<Script[]>([]);
  const [voices, setVoices] = useState<VoiceProfile[]>([]);
  const [hooks, setHooks] = useState<Hook[]>([]);
  const [refs, setRefs] = useState<Reference[]>([]);
  // The editor draft belongs to one script. Saving keeps it (so typing during a save is never lost);
  // switching scripts shows the other script's text, and restoring a version clears it.
  const [draft, setDraft] = useState<{ key: string; text: string } | null>(null);
  const ready = useClaudeReady();
  useEffect(() => { if (!brandId) void loadBrands(); }, [brandId]);
  useEffect(() => {
    if (!brandId) return;
    let live = true;
    void Promise.all([lib('studio.scripts', brandId), lib('studio.voices', brandId), lib('studio.hooks', brandId), lib('swipe.list', brandId, { sort: 'added' })]).then(([s, v, h, r]) => {
      if (!live) return;
      setScripts(s); setVoices(v); setHooks(h); setRefs(r);
    });
    return () => { live = false; };
  }, [brandId, version]);
  const script = scripts.find((s) => s.id === scriptId) ?? null;
  const draftKey = script?.id ?? '';
  const text = draft && draft.key === draftKey ? draft.text : (script?.current.text ?? '');
  const setText = (t: string) => setDraft({ key: draftKey, text: t });
  if (!brandId) return <div className="empty">Loading</div>;
  const insertHook = (h: string) => {
    const ls = text.split('\n');
    const first = ls.findIndex((l) => l.trim());
    const line = `[HOOK] ${h}`;
    if (first >= 0 && /^\[HOOK\]/i.test(ls[first]!.trim())) ls[first] = line; else ls.unshift(line);
    setText(ls.join('\n'));
  };
  const tabs: Array<[AiTab, string]> = [['draft', 'Draft'], ['voice', 'Voice check'], ['hooks', 'Hooks'], ['copy', 'Post copy']];
  return (
    <div className="sc" data-testid="script-workspace">
      <LeftPane brandId={brandId} scripts={scripts} voices={voices} hooks={hooks} onInsertHook={insertHook} />
      <Editor brandId={brandId} script={script} voices={voices} text={text} onChange={setText} onRestored={() => setDraft(null)} />
      <aside className="panel sc-right">
        <div className="tabs" role="tablist">{tabs.map(([id, label]) => <button key={id} role="tab" aria-selected={aiTab === id} onClick={() => useScriptUi.setState({ aiTab: id })}>{label}</button>)}</div>
        <div className="scroll" style={{ padding: 10 }}>
          {ready === false ? <NeedsKey /> : aiTab === 'draft' ? <DraftTab brandId={brandId} voices={voices} refs={refs} /> : aiTab === 'voice' ? <VoiceTab brandId={brandId} voices={voices} text={text} onChange={setText} /> : aiTab === 'hooks' ? <HooksTab brandId={brandId} onInsert={insertHook} /> : <CopyTab brandId={brandId} />}
        </div>
      </aside>
    </div>
  );
}

registerCommands([
  { id: 'script.new', title: 'New script', group: 'Script', description: 'Start a script in the Script studio', run: () => { useShell.getState().setWorkspace('script'); } },
  { id: 'script.draft', title: 'Draft a script with Claude', group: 'AI', description: 'Write a script in your voice, optionally from a reference', run: () => { useScriptUi.setState({ aiTab: 'draft' }); useShell.getState().setWorkspace('script'); } },
  { id: 'script.hooks', title: 'Write hooks with Claude', group: 'AI', description: 'Ten scored hooks for a topic', run: () => { useScriptUi.setState({ aiTab: 'hooks' }); useShell.getState().setWorkspace('script'); } },
]);
