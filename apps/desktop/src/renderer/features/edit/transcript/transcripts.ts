import { AUDIO_LANES, type Op, type Project } from '@director/engine';
import { useProject } from '../../project/store';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';

/** Media on the timeline that carries speech: Voice lane first, else Camera/Screen with audio. */
export function speechMedia(doc: Project): string[] {
  const ids = new Set<string>();
  for (const kind of ['voice', 'camera', 'screen'] as const) {
    for (const lane of doc.lanes.filter((l) => l.kind === kind)) for (const c of lane.clips) if (c.mediaId && doc.media[c.mediaId]?.hasAudio) ids.add(c.mediaId);
    if (ids.size && (kind === 'voice' || AUDIO_LANES.has(kind))) break;
  }
  return [...ids];
}

/** Transcribe any speech media that has no transcript yet, and store the words in the project (one undo step). */
export async function ensureTranscripts(opts: { force?: boolean; model?: string; only?: string[] } = {}): Promise<number> {
  const doc = useProject.getState().doc;
  if (!doc) return 0;
  const have = new Set((doc.transcript ?? []).map((t) => t.mediaId));
  const pool = opts.only?.length ? opts.only.filter((id) => doc.media[id]?.hasAudio) : speechMedia(doc);
  const missing = pool.filter((id) => opts.force || !have.has(id));
  if (!missing.length) return 0;
  const toast = useShell.getState().toast;
  const next = [...(doc.transcript ?? []).filter((t) => !missing.includes(t.mediaId))];
  for (const id of missing) {
    const m = doc.media[id]!;
    toast(`Transcribing ${m.name}`, 'info');
    const res = await invoke('transcribe:run', { path: m.path, projectDir: useProject.getState().dir ?? undefined, force: opts.force, model: opts.model });
    next.push({ mediaId: id, language: res.language.slice(0, 16), words: res.words.map((w) => ({ text: w.text, start: Math.round(w.start), end: Math.round(w.end), ...(w.p != null ? { p: Math.max(0, Math.min(1, w.p)) } : {}) })) });
  }
  const ops: Op[] = [{ op: 'setMeta', patch: { transcript: next } }];
  useProject.getState().apply(ops, 'Transcribe');
  return missing.length;
}
