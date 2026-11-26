import { useState } from 'react';
import { RAMP_PRESETS, setRampOps, freezeFrameOps, reverseOps, pipOps, reframeKeyframes, uid, findClip, clipEnd, type Clip, type PipLayout } from '@director/engine';
import { useProject } from '../../project/store';
import { getEdit } from '../store';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { registerEditExtensions } from '../inspector/extensions';
import { patchClip } from '../inspector/Inspector';
import { registerCommands } from '../../palette/registry';

const apply = (ops: Parameters<ReturnType<typeof useProject.getState>['apply']>[0], label: string) => useProject.getState().apply(ops, label);
const mediaOf = (clip: Clip) => useProject.getState().doc!.media[clip.mediaId!]!;
const dir = () => useProject.getState().dir ?? undefined;

export async function autoReframe(clip: Clip): Promise<boolean> {
  const m = mediaOf(clip);
  const track = await invoke('video:faces', { path: m.path, projectDir: dir() });
  if (!track.some((s) => s.faces.length)) { useShell.getState().toast('No face found to follow', 'error'); return false; }
  const doc = useProject.getState().doc!;
  const x = reframeKeyframes(track, clip, { width: m.width ?? 1920, height: m.height ?? 1080 }, doc.canvas);
  return patchClip(clip.id, { fit: 'cover', transform: { ...clip.transform, x } }, 'Auto reframe');
}

export async function removeBackground(clip: Clip): Promise<boolean> {
  useShell.getState().toast('Finding the person in every frame', 'info');
  const matte = await invoke('video:segment', { path: mediaOf(clip).path, projectDir: dir() });
  return patchClip(clip.id, { effects: [...clip.effects.filter((e) => e.type !== 'matte'), { id: uid('fx'), type: 'matte', enabled: true, params: { path: matte } }] }, 'Remove background');
}

export async function stabilize(clip: Clip, smoothing = 15): Promise<boolean> {
  useShell.getState().toast('Stabilizing (two passes)', 'info');
  const res = await invoke('video:stabilize', { path: mediaOf(clip).path, smoothing, projectDir: dir() });
  const [imp] = await invoke('media:import', { paths: [res.path], projectDir: dir(), role: mediaOf(clip).role });
  if (!imp?.ok) return false;
  const doc = useProject.getState().doc!;
  const media = { ...imp.media, name: `${mediaOf(clip).name} (stabilized)` };
  return apply([...(doc.media[media.id] ? [] : [{ op: 'addMedia' as const, media }]), { op: 'updateClip', id: clip.id, patch: { mediaId: media.id } }], 'Stabilize');
}

function Tools({ clip }: { clip: Clip }) {
  const [busy, setBusy] = useState('');
  const run = (label: string, fn: () => Promise<unknown> | unknown) => { setBusy(label); Promise.resolve(fn()).finally(() => setBusy('')); };
  const doc = useProject((s) => s.doc)!;
  const ramp = clip.speed.kind === 'ramp' ? Object.entries(RAMP_PRESETS).find(([, p]) => JSON.stringify(p.points) === JSON.stringify((clip.speed as { points: unknown }).points))?.[0] ?? 'custom' : '';
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="field"><label>Speed ramp</label>
        <select value={ramp} aria-label="Speed ramp" onChange={(e) => apply(setRampOps(doc, clip.id, e.target.value || null, getEdit().ripple), 'Speed ramp')}>
          <option value="">None</option>{Object.entries(RAMP_PRESETS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
        </select>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="mini" onClick={() => { try { apply(freezeFrameOps(doc, clip.id, getEdit().t), 'Freeze frame'); } catch (e) { useShell.getState().toast((e as Error).message, 'error'); } }}>Freeze frame</button>
        <button className={clip.reverse ? 'mini on' : 'mini'} onClick={() => apply(reverseOps(doc, clip.id), 'Reverse')}>Reverse</button>
      </div>
      <div className="field"><label>Layout</label>
        <select value="" aria-label="Picture in picture" onChange={(e) => e.target.value && apply(pipOps(doc, clip.id, e.target.value as PipLayout), 'Layout')}>
          <option value="">Picture in picture</option><option value="full">Full frame</option><option value="top-left">Top left</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option><option value="split-top">Split: top half</option><option value="split-bottom">Split: bottom half</option>
        </select>
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button className="mini" disabled={!!busy} onClick={() => run('reframe', () => autoReframe(clip))}>{busy === 'reframe' ? 'Tracking' : 'Auto reframe'}</button>
        <button className="mini" disabled={!!busy} onClick={() => run('bg', () => removeBackground(clip))}>{busy === 'bg' ? 'Segmenting' : clip.effects.some((e) => e.type === 'matte') ? 'Background removed' : 'Remove background'}</button>
        <button className="mini" disabled={!!busy} onClick={() => run('stab', () => stabilize(clip))}>{busy === 'stab' ? 'Stabilizing' : 'Stabilize'}</button>
        <button className="mini" disabled={!!busy} title="Cut to whoever is talking: close shots, side by side for quick exchanges" onClick={() => run('speakers', () => runSpeakerLayout(clip.id))}>{busy === 'speakers' ? 'Finding speakers' : 'Speaker layout'}</button>
      </div>
    </div>
  );
}

/** Speaker layout from the inspector or palette, starting at the playhead when it is inside the clip. */
async function runSpeakerLayout(clipId: string) {
  const d = useProject.getState().doc;
  const c = d && findClip(d, clipId)?.clip;
  if (!c) return;
  const t = getEdit().t;
  try {
    const { speakerLayout } = await import('./speakers');
    const r = await speakerLayout(clipId, { from: t > c.start && t < clipEnd(c) - 1e6 ? t : undefined });
    if ('applied' in r && r.applied) useShell.getState().toast(`Speaker layout: ${r.shots} shots (${r.sideBySide} side by side) for ${r.people} ${r.people === 1 ? 'person' : 'people'}`, 'ok');
  } catch (e) { useShell.getState().toast((e as Error).message, 'error'); }
}

registerEditExtensions({ video: (clip) => <Tools clip={clip} /> });
registerCommands([
  { id: 'edit.freeze', title: 'Freeze frame', group: 'Edit', description: 'Hold the frame at the playhead for 1 s', run: () => { const d = useProject.getState().doc; const id = getEdit().selection[0]; if (d && id) apply(freezeFrameOps(d, id, getEdit().t), 'Freeze frame'); } },
  { id: 'edit.speakerLayout', title: 'Speaker layout', group: 'Edit', description: 'Cut to whoever is talking in the selected interview clip (from the playhead)', run: () => { const id = getEdit().selection[0]; if (id) void runSpeakerLayout(id); } },
  { id: 'edit.reverse', title: 'Reverse clip', group: 'Edit', description: 'Play the selected clip backwards', run: () => { const d = useProject.getState().doc; const id = getEdit().selection[0]; if (d && id) apply(reverseOps(d, id), 'Reverse'); } },
]);
(globalThis as Record<string, unknown>).__directorVideoTools = { autoReframe, removeBackground, stabilize };
