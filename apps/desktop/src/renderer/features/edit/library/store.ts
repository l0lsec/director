import type { MediaRef, Op } from '@director/engine';
import { useProject, ensureProject } from '../../project/store';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';

export function getLibraryMedia(id: string): MediaRef | null {
  return useProject.getState().doc?.media[id] ?? null;
}

export const MEDIA_FILTERS = [{ name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic'] }];

/** Import files or folders into the project bin (probing, thumbnails, waveforms and proxies happen in main). */
export async function importPaths(paths: string[], role?: MediaRef['role']): Promise<MediaRef[]> {
  if (!paths.length) return [];
  await ensureProject();
  const toast = useShell.getState().toast;
  toast(`Importing ${paths.length > 1 ? `${paths.length} items` : paths[0]!.split('/').pop()}`, 'info');
  const res = await invoke('media:import', { paths, projectDir: useProject.getState().dir ?? undefined, role });
  const doc = useProject.getState().doc!;
  const existingHashes = new Set(Object.values(doc.media).map((m) => m.hash));
  const added: MediaRef[] = [];
  const ops: Op[] = [];
  for (const r of res) {
    if (!r.ok) { toast(`Could not import ${r.path.split('/').pop()}: ${r.error}`, 'error'); continue; }
    if (existingHashes.has(r.media.hash)) continue;
    existingHashes.add(r.media.hash);
    ops.push({ op: 'addMedia', media: r.media });
    added.push(r.media);
  }
  if (ops.length) useProject.getState().apply(ops, `Import ${ops.length} item${ops.length > 1 ? 's' : ''}`);
  if (added.length) toast(`Imported ${added.length} item${added.length > 1 ? 's' : ''}`, 'ok');
  else if (res.some((r) => r.ok)) toast('Already in this project', 'info');
  return added;
}

export async function importViaDialog(): Promise<MediaRef[]> {
  const paths = await invoke('dialog:open', { title: 'Import media', multi: true, filters: MEDIA_FILTERS });
  return importPaths(paths);
}

/** Mark missing files; returns the missing media. */
export async function checkMissing(): Promise<MediaRef[]> {
  const doc = useProject.getState().doc;
  if (!doc) return [];
  const list = Object.values(doc.media);
  if (!list.length) return [];
  const res = await invoke('media:check', { paths: list.map((m) => m.path) });
  const ops: Op[] = [];
  const missing: MediaRef[] = [];
  res.forEach((r, i) => {
    const m = list[i]!;
    if (!r.exists !== !!m.missing) ops.push({ op: 'updateMedia', id: m.id, patch: r.exists ? {} : { missing: true }, unset: r.exists ? ['missing'] : undefined });
    if (!r.exists) missing.push(m);
  });
  if (ops.length) useProject.getState().apply(ops, 'Check media');
  return missing;
}

/** Find a moved file by content hash in folders the user picks (or the project's parent folder). */
export async function relink(m: MediaRef, dirs?: string[]): Promise<boolean> {
  const search = dirs ?? (await invoke('dialog:open', { title: `Where is ${m.name}?`, directory: true }));
  if (!search.length) return false;
  const found = await invoke('media:relink', { hash: m.hash, dirs: search });
  if (!found) { useShell.getState().toast(`No file matching ${m.name} found there`, 'error'); return false; }
  return useProject.getState().apply([{ op: 'updateMedia', id: m.id, patch: { path: found }, unset: ['missing'] }], `Relink ${m.name}`);
}
