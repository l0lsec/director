import { evalAnim, withKeyframe, findClip, setSpeedOps, type Animatable, type Clip, type Project, type TextSpec } from '@director/engine';
import { useProject } from '../../project/store';
import { useEdit, getEdit } from '../store';
import { getEditExtensions } from './extensions';

const apply = (ops: Parameters<ReturnType<typeof useProject.getState>['apply']>[0], label: string) => useProject.getState().apply(ops, label);
export function patchClip(id: string, patch: Partial<Clip>, label: string): boolean { return apply([{ op: 'updateClip', id, patch }], label); }

/** A numeric control for an animatable property, with a keyframe toggle at the playhead. */
export function AnimField({ label, value, min, max, step, onChange, tRel, unit }: { label: string; value: Animatable; min: number; max: number; step: number; tRel: number; unit?: string; onChange: (a: Animatable, label: string) => void }) {
  const v = evalAnim(value, tRel);
  const hasKf = !!value.keyframes?.some((k) => Math.abs(k.t - tRel) < 20_000);
  const animated = !!value.keyframes?.length;
  const set = (n: number) => onChange(animated ? withKeyframe(value, tRel, n) : { ...value, value: n }, label);
  return (
    <div className="field">
      <label>{label}</label>
      <input type="range" min={min} max={max} step={step} value={v} onChange={(e) => set(Number(e.target.value))} aria-label={label} />
      <input type="number" min={min} max={max} step={step} value={Number(v.toFixed(3))} onChange={(e) => set(Number(e.target.value))} aria-label={`${label} value`} />
      <span className="unit">{unit}</span>
      <button className={`kf ${hasKf ? 'on' : animated ? 'part' : ''}`} title={hasKf ? 'Remove keyframe' : 'Add keyframe at playhead'} aria-label={`${label} keyframe`}
        onClick={() => {
          if (hasKf) {
            const kfs = value.keyframes!.filter((k) => Math.abs(k.t - tRel) >= 20_000);
            onChange(kfs.length ? { value: value.value, keyframes: kfs } : { value: v }, `${label} keyframe`);
          } else onChange(withKeyframe(animated ? value : { value: v, keyframes: [{ t: 0, v, ease: 'ease' }] }, tRel, v, 'ease'), `${label} keyframe`);
        }}>◆</button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="insp-section"><h4>{title}</h4>{children}</section>;
}

function CanvasPanel({ doc }: { doc: Project }) {
  const bg = doc.canvas.background;
  return (
    <>
      <Section title="Project">
        <div className="field"><label>Name</label><input defaultValue={doc.name} onBlur={(e) => e.target.value && e.target.value !== doc.name && apply([{ op: 'setMeta', patch: { name: e.target.value } }], 'Rename project')} aria-label="Project name" /></div>
        <div className="field"><label>Size</label><span>{doc.canvas.width} x {doc.canvas.height} at {(doc.canvas.fps.num / doc.canvas.fps.den).toFixed(2)} fps</span></div>
      </Section>
      <Section title="Background">
        <div className="field">
          <label>Fill</label>
          <select value={bg.kind} aria-label="Background fill" onChange={(e) => apply([{ op: 'setCanvas', patch: { background: e.target.value === 'blur' ? { kind: 'blur', amount: 0.6 } : { kind: 'color', color: '#000000' } } }], 'Background')}>
            <option value="color">Color</option><option value="blur">Blurred video</option>
          </select>
          {bg.kind === 'color' && <input type="color" value={bg.color} aria-label="Background color" onChange={(e) => apply([{ op: 'setCanvas', patch: { background: { kind: 'color', color: e.target.value } } }], 'Background color')} />}
        </div>
      </Section>
      <p className="hint" style={{ padding: '0 12px' }}>Select a clip to edit it. Double-click media in the library to add it at the playhead.</p>
    </>
  );
}

function ClipPanel({ doc, clip }: { doc: Project; clip: Clip }) {
  const t = useEdit((s) => s.t);
  const tRel = Math.max(0, t - clip.start);
  const tf = clip.transform;
  const setTf = (k: keyof Clip['transform'], v: unknown, label: string) => patchClip(clip.id, { transform: { ...tf, [k]: v } }, label);
  const media = clip.mediaId ? doc.media[clip.mediaId] : undefined;
  const rate = clip.speed.kind === 'constant' ? clip.speed.rate : 1;
  const visual = clip.kind !== 'media' || !!media?.hasVideo;
  const ext = getEditExtensions();
  return (
    <>
      <Section title={clip.text ? 'Text' : media ? media.name : clip.kind}>
        {clip.text && <TextFields clip={clip} />}
        <div className="field"><label>Enabled</label><input type="checkbox" aria-label="Clip enabled" checked={clip.enabled} onChange={(e) => patchClip(clip.id, { enabled: e.target.checked }, 'Enable clip')} /></div>
      </Section>
      {visual && (
        <Section title="Transform">
          <AnimField label="Position X" value={tf.x} min={-2000} max={2000} step={1} tRel={tRel} unit="px" onChange={(a, l) => setTf('x', a, l)} />
          <AnimField label="Position Y" value={tf.y} min={-2000} max={2000} step={1} tRel={tRel} unit="px" onChange={(a, l) => setTf('y', a, l)} />
          <AnimField label="Scale" value={tf.scale} min={0.1} max={5} step={0.01} tRel={tRel} unit="x" onChange={(a, l) => setTf('scale', a, l)} />
          <AnimField label="Rotation" value={tf.rotation} min={-180} max={180} step={0.5} tRel={tRel} unit="deg" onChange={(a, l) => setTf('rotation', a, l)} />
          <AnimField label="Opacity" value={tf.opacity} min={0} max={1} step={0.01} tRel={tRel} onChange={(a, l) => setTf('opacity', a, l)} />
          {media && (
            <>
              <div className="field"><label>Fit</label>
                <select value={clip.fit ?? 'cover'} aria-label="Fit" onChange={(e) => patchClip(clip.id, { fit: e.target.value as Clip['fit'] }, 'Fit')}><option value="cover">Fill (crop)</option><option value="contain">Fit (bars)</option><option value="stretch">Stretch</option></select>
              </div>
              {(['left', 'top', 'right', 'bottom'] as const).map((side) => (
                <div className="field" key={side}><label>Crop {side}</label><input type="range" min={0} max={0.45} step={0.005} value={tf.crop[side]} aria-label={`Crop ${side}`} onChange={(e) => setTf('crop', { ...tf.crop, [side]: Number(e.target.value) }, 'Crop')} /><span className="unit">{Math.round(tf.crop[side] * 100)}%</span></div>
              ))}
              <div className="field"><label>Flip</label>
                <button className={tf.flipH ? 'mini on' : 'mini'} onClick={() => setTf('flipH', !tf.flipH, 'Flip horizontal')}>Horizontal</button>
                <button className={tf.flipV ? 'mini on' : 'mini'} onClick={() => setTf('flipV', !tf.flipV, 'Flip vertical')}>Vertical</button>
              </div>
            </>
          )}
        </Section>
      )}
      {media?.hasVideo && ext.video && <Section title="Video tools">{ext.video(clip)}</Section>}
      {media && clip.kind === 'media' && (
        <Section title="Speed">
          <div className="field speeds">
            {[0.25, 0.5, 1, 1.25, 1.5, 2, 3, 4].map((r) => <button key={r} className={rate === r ? 'mini on' : 'mini'} onClick={() => apply(setSpeedOps(doc, clip.id, r, getEdit().ripple), `Speed ${r}x`)}>{r}x</button>)}
          </div>
          <div className="field"><label>Custom</label><input type="number" min={0.05} max={20} step={0.05} value={rate} aria-label="Speed" onChange={(e) => { const r = Number(e.target.value); if (r >= 0.05 && r <= 20) apply(setSpeedOps(doc, clip.id, r, getEdit().ripple), `Speed ${r}x`); }} /></div>
          <div className="field"><label>Keep pitch</label><input type="checkbox" aria-label="Keep pitch" checked={clip.speed.preservePitch} onChange={(e) => patchClip(clip.id, { speed: { ...clip.speed, preservePitch: e.target.checked } }, 'Keep pitch')} /></div>
          {ext.speed?.(clip)}
        </Section>
      )}
      {clip.audio && (
        <Section title="Audio">
          <AnimField label="Volume" value={clip.audio.gainDb} min={-60} max={12} step={0.5} tRel={tRel} unit="dB" onChange={(a, l) => patchClip(clip.id, { audio: { ...clip.audio!, gainDb: a } }, l)} />
          <div className="field"><label>Fade in</label><input type="range" min={0} max={5} step={0.05} value={clip.audio.fadeIn / 1e6} aria-label="Fade in" onChange={(e) => patchClip(clip.id, { audio: { ...clip.audio!, fadeIn: Math.round(Number(e.target.value) * 1e6) } }, 'Fade in')} /><span className="unit">{(clip.audio.fadeIn / 1e6).toFixed(2)} s</span></div>
          <div className="field"><label>Fade out</label><input type="range" min={0} max={5} step={0.05} value={clip.audio.fadeOut / 1e6} aria-label="Fade out" onChange={(e) => patchClip(clip.id, { audio: { ...clip.audio!, fadeOut: Math.round(Number(e.target.value) * 1e6) } }, 'Fade out')} /><span className="unit">{(clip.audio.fadeOut / 1e6).toFixed(2)} s</span></div>
          <div className="field"><label>Pan</label><input type="range" min={-1} max={1} step={0.05} value={clip.audio.pan} aria-label="Pan" onChange={(e) => patchClip(clip.id, { audio: { ...clip.audio!, pan: Number(e.target.value) } }, 'Pan')} /></div>
          <div className="field"><label>Mute</label><input type="checkbox" aria-label="Mute clip" checked={clip.audio.muted} onChange={(e) => patchClip(clip.id, { audio: { ...clip.audio!, muted: e.target.checked } }, 'Mute clip')} /></div>
          {ext.audio?.(clip)}
        </Section>
      )}
      {ext.effects && visual && <Section title="Effects">{ext.effects(clip)}</Section>}
      {ext.transitions && visual && <Section title="Transition in">{ext.transitions(clip)}</Section>}
    </>
  );
}

function TextFields({ clip }: { clip: Clip }) {
  const tx = clip.text!;
  const set = (p: Partial<TextSpec>, label: string) => patchClip(clip.id, { text: { ...tx, ...p }, ...(p.content != null ? { name: p.content.slice(0, 60) } : {}) }, label);
  const ext = getEditExtensions();
  return (
    <>
      <textarea className="text-content" aria-label="Text" defaultValue={tx.content} rows={3} onBlur={(e) => e.target.value !== tx.content && set({ content: e.target.value }, 'Edit text')} />
      <div className="field"><label>Size</label><input type="range" min={16} max={300} value={tx.size} aria-label="Text size" onChange={(e) => set({ size: Number(e.target.value) }, 'Text size')} /><span className="unit">{tx.size}</span></div>
      <div className="field"><label>Color</label><input type="color" value={tx.color} aria-label="Text color" onChange={(e) => set({ color: e.target.value }, 'Text color')} />
        <label>Weight</label><select value={tx.weight} aria-label="Weight" onChange={(e) => set({ weight: Number(e.target.value) }, 'Weight')}>{[400, 600, 700, 800, 900].map((w) => <option key={w}>{w}</option>)}</select></div>
      <div className="field"><label>Outline</label><input type="range" min={0} max={20} value={tx.stroke?.width ?? 0} aria-label="Outline" onChange={(e) => set({ stroke: { color: tx.stroke?.color ?? '#000000', width: Number(e.target.value) } }, 'Outline')} />
        <input type="color" value={tx.stroke?.color ?? '#000000'} aria-label="Outline color" onChange={(e) => set({ stroke: { color: e.target.value, width: tx.stroke?.width ?? 4 } }, 'Outline color')} /></div>
      <div className="field"><label>Box</label><input type="checkbox" checked={!!tx.box} aria-label="Background box" onChange={(e) => set({ box: e.target.checked ? { color: 'rgba(0,0,0,0.6)', padding: 18, radius: 14 } : undefined }, 'Text box')} />
        <label>Caps</label><input type="checkbox" checked={!!tx.uppercase} aria-label="Uppercase" onChange={(e) => set({ uppercase: e.target.checked }, 'Uppercase')} /></div>
      <div className="field"><label>Animate in</label>
        <select value={tx.animationIn ?? ''} aria-label="Animation in" onChange={(e) => set({ animationIn: e.target.value || undefined }, 'Animation in')}><option value="">None</option><option value="fade">Fade</option><option value="pop">Pop</option><option value="slide-up">Slide up</option><option value="slide-left">Slide left</option><option value="zoom">Zoom</option><option value="typewriter">Typewriter</option></select>
        <label>Out</label>
        <select value={tx.animationOut ?? ''} aria-label="Animation out" onChange={(e) => set({ animationOut: e.target.value || undefined }, 'Animation out')}><option value="">None</option><option value="fade">Fade</option><option value="pop">Pop</option><option value="slide-up">Slide</option><option value="zoom">Zoom</option></select>
      </div>
      {ext.text?.(clip)}
    </>
  );
}

export function Inspector() {
  const doc = useProject((s) => s.doc);
  const selection = useEdit((s) => s.selection);
  if (!doc) return null;
  const loc = selection.length === 1 ? findClip(doc, selection[0]!) : null;
  return (
    <div className="inspector scroll" data-testid="inspector">
      {loc ? <ClipPanel doc={doc} clip={loc.clip} /> : selection.length > 1 ? <p className="hint" style={{ padding: 12 }}>{selection.length} clips selected</p> : <CanvasPanel doc={doc} />}
    </div>
  );
}
