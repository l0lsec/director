import { useEffect, useState } from 'react';
import { makeTemplate, applyTemplateOps, type Template, type TextSpec, type LaneKind } from '@director/engine';
import { useProject } from '../../project/store';
import { getEdit } from '../store';
import { addText } from '../commands';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { registerEditPanel } from '../panels';

const PRESETS: Array<{ id: string; label: string; lane: LaneKind; y: number; spec: Partial<TextSpec> }> = [
  { id: 'title', label: 'Big title', lane: 'titles', y: -0.25, spec: { size: 120, weight: 900, color: '#ffffff', stroke: { color: '#000000', width: 10 }, uppercase: true, animationIn: 'pop', animationOut: 'fade' } },
  { id: 'lower', label: 'Lower third', lane: 'titles', y: 0.28, spec: { size: 54, weight: 700, color: '#ffffff', box: { color: 'rgba(0,0,0,0.72)', padding: 20, radius: 12 }, maxWidth: 0.7, animationIn: 'slide-left', animationOut: 'fade' } },
  { id: 'subtitle', label: 'Subtitle', lane: 'titles', y: 0.36, spec: { size: 48, weight: 600, color: '#ffffff', shadow: { color: 'rgba(0,0,0,0.9)', blur: 10, x: 0, y: 2 } } },
  { id: 'callout', label: 'Callout', lane: 'graphics', y: -0.05, spec: { size: 76, weight: 900, color: '#1a1405', box: { color: '#f5b83d', padding: 22, radius: 18 }, animationIn: 'zoom', animationOut: 'fade' } },
  { id: 'type', label: 'Typewriter', lane: 'titles', y: 0, spec: { size: 64, weight: 700, color: '#ffffff', animationIn: 'typewriter', animationDuration: 900_000 } },
];
const EMOJI = ['🔥', '👀', '💡', '✅', '❌', '🚀', '😂', '🤯', '👉', '💰', '⚡', '🎯'];

export function TextPanel() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [fill, setFill] = useState<Record<string, string[]>>({});
  useEffect(() => { void invoke('settings:get', { key: 'templates' }).then((t) => setTemplates((t as Template[] | null) ?? [])); }, []);
  const doc = useProject((s) => s.doc);
  const saveTemplates = async (t: Template[]) => { setTemplates(t); await invoke('settings:set', { key: 'templates', value: t }); };
  const addPreset = (p: (typeof PRESETS)[number]) => {
    const d = useProject.getState().doc!;
    addText(p.label === 'Big title' ? 'Your big idea' : p.label, p.lane, {});
    const id = getEdit().selection[0];
    const c = id ? d && useProject.getState().doc!.lanes.flatMap((l) => l.clips).find((x) => x.id === id) : null;
    if (c) useProject.getState().apply([{ op: 'updateClip', id: c.id, patch: { text: { ...c.text!, ...p.spec }, transform: { ...c.transform, y: { value: Math.round(p.y * d.canvas.height) } } } }], `${p.label} style`);
  };
  const saveSelection = async () => {
    const d = useProject.getState().doc!;
    const sel = getEdit().selection;
    if (!sel.length) { useShell.getState().toast('Select the clips to save as a template', 'info'); return; }
    const name = `Template ${templates.length + 1}`;
    await saveTemplates([...templates, makeTemplate(d, sel, name)]);
    useShell.getState().toast(`Saved "${name}"`, 'ok');
  };
  const apply = (t: Template) => {
    const d = useProject.getState().doc!;
    useProject.getState().apply(applyTemplateOps(d, t, getEdit().t, fill[t.id] ?? []), `Apply ${t.name}`);
  };
  (globalThis as Record<string, unknown>).__directorText = { saveSelection, templates: () => templates, apply: (id: string, texts: string[]) => { const t = templates.find((x) => x.id === id)!; useProject.getState().apply(applyTemplateOps(useProject.getState().doc!, t, getEdit().t, texts), `Apply ${t.name}`); } };
  if (!doc) return null;
  return (
    <div className="col scroll" style={{ padding: 10, gap: 10, flex: 1 }} data-testid="text-panel">
      <div className="panel-title" style={{ padding: 0 }}>Styles</div>
      <div className="style-grid">{PRESETS.map((p) => <button key={p.id} className="style" onClick={() => addPreset(p)}>{p.label}</button>)}</div>
      <div className="panel-title" style={{ padding: 0 }}>Stickers</div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{EMOJI.map((e) => <button key={e} className="mini" style={{ fontSize: 20 }} onClick={() => addText(e, 'graphics', { text: { content: e, font: 'Apple Color Emoji', size: 220, weight: 400, color: '#ffffff', align: 'center', lineHeight: 1, maxWidth: 0.5, animationIn: 'pop', animationDuration: 200_000 } })}>{e}</button>)}</div>
      <div className="panel-title" style={{ padding: 0 }}>Templates</div>
      <button onClick={() => void saveSelection()}>Save selection as template</button>
      {templates.map((t) => (
        <div key={t.id} className="fx">
          <div className="row" style={{ justifyContent: 'space-between' }}><strong>{t.name}</strong><button className="mini" onClick={() => void saveTemplates(templates.filter((x) => x.id !== t.id))}>Delete</button></div>
          {t.clips.filter((c) => c.placeholder).map((c, i) => (
            <input key={i} placeholder={c.clip.text?.content ?? c.placeholder} aria-label={c.placeholder} value={fill[t.id]?.[i] ?? ''} onChange={(e) => { const arr = [...(fill[t.id] ?? [])]; arr[i] = e.target.value; setFill({ ...fill, [t.id]: arr }); }} />
          ))}
          <button className="mini primary" onClick={() => apply(t)}>Add at playhead</button>
        </div>
      ))}
    </div>
  );
}

registerEditPanel({ id: 'text', label: 'Text', component: TextPanel, order: 25 });
