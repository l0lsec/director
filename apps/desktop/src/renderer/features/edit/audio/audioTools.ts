import { uid, laneOfKind, type Clip, type MediaRef, type Op } from '@director/engine';
import { useProject } from '../../project/store';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';

/** Replace a clip's audio with a cleaned or enhanced copy (new media; one undo step). */
export async function processClipAudio(clip: Clip, opts: { denoise?: boolean; enhance?: boolean }): Promise<boolean> {
  const doc = useProject.getState().doc;
  if (!doc || !clip.mediaId) return false;
  const src = doc.media[clip.mediaId]!;
  useShell.getState().toast(opts.denoise ? 'Removing background noise' : 'Enhancing voice', 'info');
  const res = await invoke('audio:process', { path: src.path, denoise: opts.denoise, enhance: opts.enhance, projectDir: useProject.getState().dir ?? undefined });
  const [imp] = await invoke('media:import', { paths: [res.path], projectDir: useProject.getState().dir ?? undefined, role: 'mic' });
  if (!imp || !imp.ok) return false;
  const media: MediaRef = { ...imp.media, name: `${src.name} (${opts.denoise ? 'clean' : ''}${opts.denoise && opts.enhance ? ' + ' : ''}${opts.enhance ? 'enhanced' : ''})` };
  const cur = useProject.getState().doc!;
  const ops: Op[] = [];
  if (!cur.media[media.id]) ops.push({ op: 'addMedia', media });
  const voice = laneOfKind(cur, 'voice');
  const onVoice = cur.lanes.find((l) => l.clips.some((c) => c.id === clip.id))?.kind === 'voice';
  if (onVoice || !src.hasVideo) {
    ops.push({ op: 'updateClip', id: clip.id, patch: { mediaId: media.id } });
  } else if (voice) {
    // Video clip: mute its own audio and put the processed voice on the Voice lane, linked.
    const link = clip.linkGroup ?? uid('link');
    ops.push({ op: 'updateClip', id: clip.id, patch: { linkGroup: link, audio: { ...clip.audio!, muted: true } } });
    ops.push({ op: 'addClip', laneId: voice.id, clip: { ...clip, id: uid('clip'), mediaId: media.id, linkGroup: link, effects: [], audio: { ...clip.audio!, muted: false } } });
  }
  return useProject.getState().apply(ops, opts.denoise ? 'Clean up voice' : 'Enhance voice');
}

/** Beat markers for a music clip, mapped from source time to the timeline. */
export async function addBeatMarkers(clip: Clip): Promise<number> {
  const doc = useProject.getState().doc;
  if (!doc || !clip.mediaId) return 0;
  const beats = await invoke('audio:beats', { path: doc.media[clip.mediaId]!.path, projectDir: useProject.getState().dir ?? undefined });
  const rate = clip.speed.kind === 'constant' ? clip.speed.rate : 1;
  const ops: Op[] = beats
    .map((s) => Math.round(s * 1e6))
    .filter((t) => t >= clip.in && t < clip.out)
    .map((t) => ({ op: 'addMarker' as const, marker: { id: uid('beat'), t: Math.round(clip.start + (t - clip.in) / rate), kind: 'beat' as const, label: 'Beat' } }));
  useProject.getState().apply(ops, `Beat markers (${ops.length})`);
  return ops.length;
}
