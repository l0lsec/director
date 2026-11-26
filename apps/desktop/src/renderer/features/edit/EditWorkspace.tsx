import { useEffect, useState } from 'react';
import './edit.css';
import { useProject, ensureProject } from '../project/store';
import { useEdit, setEdit, type Panel } from './store';
import { Preview } from './preview/Preview';
import { Timeline } from './timeline/Timeline';
import { Library } from './library/Library';
import { Inspector } from './inspector/Inspector';
import { handleEditKey, setPreset, type PresetName } from './keymap/keymap';
import { invoke } from '../../shell/bridge';
import './commands';
import { getEditPanels } from './panels';
import './files/FilesPanel';
import './transcript/TranscriptPanel';
import './autocut/AutoCutPanel';
import './captions/CaptionsPanel';
import './effects/EffectsPanel';
import './audio/AudioPanel';
import './advanced/VideoTools';
import './text/TextPanel';
import './director/DirectorPanel';
import '../assistant/AssistantPanel';
import '../agent/AgentPanel';
import { makeReel } from './makereel/makeReel';

export default function EditWorkspace() {
  const doc = useProject((s) => s.doc);
  const { tool, snapping, ripple, panel } = useEdit();
  const canUndo = useProject((s) => s.canUndo);
  const canRedo = useProject((s) => s.canRedo);
  const undoLabel = useProject((s) => s.undoLabel);
  const [preset, setP] = useState<PresetName>('capcut');

  useEffect(() => { void ensureProject(); void invoke('settings:get', { key: 'edit.keymap' }).then((v) => { if (v === 'premiere' || v === 'capcut') { setPreset(v); setP(v); } }); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { handleEditKey(e); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const panels = getEditPanels();
  const tabs: Array<{ id: Panel; label: string }> = [{ id: 'media', label: 'Media' }, ...panels.map((p) => ({ id: p.id, label: p.label }))];
  const Active = panels.find((p) => p.id === panel)?.component;

  return (
    <div className="edit" data-testid="edit-workspace">
      <aside className="edit-left panel">
        <div className="tabs" role="tablist">
          {tabs.map((t) => <button key={t.id} role="tab" aria-selected={panel === t.id} onClick={() => setEdit({ panel: t.id })}>{t.label}</button>)}
        </div>
        {panel === 'media' || !Active ? <Library /> : <Active />}
      </aside>
      <section className="edit-center"><Preview /></section>
      <aside className="edit-right panel"><Inspector /></aside>
      <section className="edit-bottom panel">
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Tool">
            {(['select', 'blade', 'slip', 'roll'] as const).map((t) => <button key={t} aria-pressed={tool === t} onClick={() => setEdit({ tool: t })}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
          </div>
          <label className="row"><input type="checkbox" checked={snapping} onChange={(e) => setEdit({ snapping: e.target.checked })} /> Snap</label>
          <label className="row"><input type="checkbox" checked={ripple} onChange={(e) => setEdit({ ripple: e.target.checked })} /> Ripple</label>
          <button className="primary mini" data-testid="make-reel" onClick={() => void makeReel()} title="Best takes, remove pauses and fillers, captions, zooms (one undo)">Make Reel</button>
          <button className="mini" disabled={!canUndo} title={undoLabel ? `Undo ${undoLabel}` : 'Undo'} onClick={() => useProject.getState().undo()}>Undo</button>
          <button className="mini" disabled={!canRedo} onClick={() => useProject.getState().redo()}>Redo</button>
          <span style={{ flex: 1 }} />
          <label className="row">Shortcuts
            <select value={preset} aria-label="Shortcut preset" onChange={(e) => { const v = e.target.value as PresetName; setPreset(v); setP(v); void invoke('settings:set', { key: 'edit.keymap', value: v }); }}>
              <option value="capcut">CapCut</option><option value="premiere">Premiere</option>
            </select>
          </label>
          <span className="hint">{doc ? `${Object.keys(doc.media).length} media · ${doc.lanes.reduce((n, l) => n + l.clips.length, 0)} clips` : ''}</span>
        </div>
        <Timeline />
      </section>
    </div>
  );
}
