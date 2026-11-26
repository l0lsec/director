import { uid, EFFECT_DEFS, EFFECT_TIME_KEYS, TRANSITIONS as TRANSITION_DEFS, effectDefaults, type Clip, type Effect } from '@director/engine';
import { registerEditExtensions } from '../inspector/extensions';
import { patchClip } from '../inspector/Inspector';
import { invoke } from '../../../shell/bridge';

// One catalog for the UI, the renderer and agent tools (packages/engine/src/catalog.ts).
const EFFECTS = Object.fromEntries(Object.values(EFFECT_DEFS).filter((d) => d.addable).map((d) => [d.type, { label: d.label, params: d.params.filter((p) => p.def !== undefined).map((p) => ({ ...p, def: p.def! })) }]));
const TIME_KEYS = EFFECT_TIME_KEYS;

export function newEffect(type: string, extra: Effect['params'] = {}): Effect {
  const def = EFFECTS[type]!;
  if (!def) throw new Error(`unknown effect ${type}`);
  return { id: uid('fx'), type, enabled: true, params: { ...Object.fromEntries(Object.entries(effectDefaults(type)).filter(([k]) => typeof k === 'string' && def.params.some((p) => p.key === k))), ...extra } };
}

function Effects({ clip }: { clip: Clip }) {
  const set = (effects: Effect[], label: string) => patchClip(clip.id, { effects }, label);
  const add = async (type: string) => {
    if (type === 'lut') {
      const [path] = await invoke('dialog:open', { title: 'Choose a .cube LUT', filters: [{ name: 'LUT', extensions: ['cube'] }] });
      if (!path) return;
      set([...clip.effects, newEffect('lut', { path })], 'Add LUT');
      return;
    }
    set([...clip.effects, newEffect(type, type === 'chromakey' ? { color: '#00ff00' } : type === 'mask' ? { shape: 'rect', invert: false } : {})], `Add ${EFFECTS[type]!.label}`);
  };
  return (
    <div className="effects" data-testid="effects">
      {clip.effects.map((e, i) => {
        const def = EFFECTS[e.type];
        if (!def) return null;
        const update = (k: string, v: number | string | boolean) => set(clip.effects.map((x, j) => (j === i ? { ...x, params: { ...x.params, [k]: v } } : x)), `${def.label}: ${k}`);
        return (
          <div key={e.id} className="fx">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <label className="row"><input type="checkbox" checked={e.enabled} onChange={(ev) => set(clip.effects.map((x, j) => (j === i ? { ...x, enabled: ev.target.checked } : x)), `${def.label} on/off`)} /> <strong>{def.label}</strong></label>
              <button className="mini" aria-label={`Remove ${def.label}`} onClick={() => set(clip.effects.filter((_, j) => j !== i), `Remove ${def.label}`)}>Remove</button>
            </div>
            {e.type === 'lut' && <div className="hint">{String(e.params.path).split('/').pop()}</div>}
            {e.type === 'chromakey' && <div className="field"><label>Key color</label><input type="color" value={String(e.params.color ?? '#00ff00')} onChange={(ev) => update('color', ev.target.value)} /></div>}
            {e.type === 'mask' && <div className="field"><label>Shape</label><select value={String(e.params.shape)} onChange={(ev) => update('shape', ev.target.value)}><option value="rect">Rectangle</option><option value="ellipse">Ellipse</option></select><label>Invert</label><input type="checkbox" checked={e.params.invert === true} onChange={(ev) => update('invert', ev.target.checked)} /></div>}
            {def.params.map((p) => {
              const raw = typeof e.params[p.key] === 'number' ? (e.params[p.key] as number) : p.def;
              const v = TIME_KEYS.has(p.key) ? raw / 1e6 : raw;
              return (
                <div className="field" key={p.key}>
                  <label>{p.label}</label>
                  <input type="range" min={p.min} max={p.max} step={p.step} value={v} aria-label={`${def.label} ${p.label}`} onChange={(ev) => update(p.key, TIME_KEYS.has(p.key) ? Math.round(Number(ev.target.value) * 1e6) : Number(ev.target.value))} />
                  <span className="unit">{v.toFixed(2)}</span>
                </div>
              );
            })}
          </div>
        );
      })}
      <select aria-label="Add effect" value="" onChange={(e) => { if (e.target.value) void add(e.target.value); }}>
        <option value="">Add effect</option>
        {Object.entries(EFFECTS).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
      </select>
    </div>
  );
}

const TRANSITIONS = [['', 'None'], ...TRANSITION_DEFS.filter((t) => t.id !== 'dissolve').map((t) => [t.id, t.label])] as const;

function Transition({ clip }: { clip: Clip }) {
  const tr = clip.transitionIn;
  return (
    <div className="field">
      <select aria-label="Transition in" value={tr?.type ?? ''} onChange={(e) => patchClip(clip.id, { transitionIn: e.target.value ? { type: e.target.value, duration: tr?.duration ?? 400_000 } : undefined }, 'Transition')}>
        {TRANSITIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
      {tr && <><input type="range" min={0.1} max={2} step={0.05} value={tr.duration / 1e6} aria-label="Transition length" onChange={(e) => patchClip(clip.id, { transitionIn: { ...tr, duration: Math.round(Number(e.target.value) * 1e6) } }, 'Transition length')} /><span className="unit">{(tr.duration / 1e6).toFixed(2)} s</span></>}
    </div>
  );
}

registerEditExtensions({ effects: (clip) => <Effects clip={clip} />, transitions: (clip) => <Transition clip={clip} /> });
(globalThis as Record<string, unknown>).__directorEffects = { newEffect, EFFECTS };
