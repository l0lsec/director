import {
  applyOps, insertClipOps, newClip, newLane, defaultAudio, laneOfKind, clipEnd, guessRole, fileKindOf, LANE_FOR_ROLE, LANE_ORDER, LANE_LABEL, AUDIO_LANES,
  type LaneKind, type MediaRef, type MediaRole, type Op, type Project,
} from '@director/engine';
import { useProject, ensureProject } from '../../project/store';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';
import { getEdit, setEdit } from '../store';

/** A file from the Files panel: its absolute path and its path below the opened folder (for the lane guess). */
export interface PickedFile { path: string; rel: string }
export type Placement = { mode: 'playhead' } | { mode: 'end' } | { mode: 'at'; t: number };

/** The media role a lane implies, so a file added to a lane keeps that lane as its natural home. */
export const ROLE_FOR_LANE: Partial<Record<LaneKind, MediaRole>> = { camera: 'camera', screen: 'screen', broll: 'broll', voice: 'mic', music: 'music', sfx: 'sfx' };

/** Lanes a file of this kind can go on, in menu order. */
export function lanesFor(path: string): LaneKind[] {
  const k = fileKindOf(path.split('/').pop() ?? '');
  return k === 'audio' ? ['voice', 'music', 'sfx'] : k === 'video' ? ['camera', 'screen', 'broll'] : k === 'image' ? ['broll'] : [];
}

/** Where a file lands when no lane is chosen: its category folder's lane, or the usual default for its kind. */
export function defaultLane(f: PickedFile): { lane: LaneKind; why: string } {
  const kind = fileKindOf(f.path.split('/').pop() ?? '');
  const g = kind ? guessRole(f.rel, kind) : null;
  if (g && kind !== 'image') return { lane: g.lane, why: `from "${g.from}"` };
  return { lane: kind === 'audio' ? 'music' : 'broll', why: kind === 'image' ? 'images go on B-roll' : 'default' };
}

const toast = (m: string, k: 'info' | 'ok' | 'error' = 'info') => useShell.getState().toast(m, k);
const fileName = (p: string) => p.split('/').pop() ?? p;

interface Resolved { file: PickedFile; media: MediaRef; isNew: boolean }

/** Probe the files (thumbnails, waveforms, proxies are made in main) and match them to media already in the project. */
async function resolve(files: PickedFile[], roleOf: (f: PickedFile) => MediaRole | undefined): Promise<{ items: Resolved[]; failed: string[] }> {
  await ensureProject();
  const groups = new Map<string, PickedFile[]>();
  for (const f of files) { const r = roleOf(f) ?? ''; groups.set(r, [...(groups.get(r) ?? []), f]); }
  const byPath = new Map<string, MediaRef>();
  const failed: string[] = [];
  const projectDir = useProject.getState().dir ?? undefined;
  for (const [role, group] of groups) {
    const res = await invoke('media:import', { paths: group.map((f) => f.path), projectDir, role: (role || undefined) as MediaRole | undefined });
    for (const r of res) { if (r.ok) byPath.set(r.media.path, r.media); else failed.push(`${fileName(r.path)}: ${r.error}`); }
  }
  const doc = useProject.getState().doc!;
  const byHash = new Map(Object.values(doc.media).map((m) => [m.hash, m]));
  const items: Resolved[] = [];
  for (const f of files) {
    const m = byPath.get(f.path);
    if (!m) { if (!failed.some((x) => x.startsWith(fileName(f.path)))) failed.push(`${fileName(f.path)}: not a video, audio or image file`); continue; }
    const have = byHash.get(m.hash);
    if (have) items.push({ file: f, media: have, isNew: false });
    else { byHash.set(m.hash, m); items.push({ file: f, media: m, isNew: true }); }
  }
  return { items, failed };
}

/** The lane of a kind, adding one in the standard order when the project has none. */
function ensureLane(work: Project, kind: LaneKind): { laneId: string; ops: Op[] } {
  const have = laneOfKind(work, kind);
  if (have) return { laneId: have.id, ops: [] };
  const lane = newLane(kind);
  const rank = LANE_ORDER.indexOf(kind);
  const index = work.lanes.filter((l) => LANE_ORDER.indexOf(l.kind) < rank).length;
  return { laneId: lane.id, ops: [{ op: 'addLane', lane, index }] };
}

/**
 * Put files on the timeline as one undo step. Without a lane, each file goes to its category folder's lane.
 * Several files on one lane play one after another from the start point.
 */
export async function placeFiles(files: PickedFile[], opts: { lane?: LaneKind; placement?: Placement } = {}): Promise<string[]> {
  if (!files.length) return [];
  const placement = opts.placement ?? { mode: 'playhead' };
  const laneOf = (f: PickedFile) => opts.lane ?? defaultLane(f).lane;
  const { items, failed } = await resolve(files, (f) => ROLE_FOR_LANE[laneOf(f)] ?? (fileKindOf(fileName(f.path)) === 'image' ? 'image' : undefined));
  for (const f of failed) toast(`Could not add ${f}`, 'error');
  if (!items.length) return [];
  let work = useProject.getState().doc!;
  const all: Op[] = [];
  const cursor = new Map<string, number>();
  const added: string[] = [];
  const lanesUsed = new Set<LaneKind>();
  for (const { file, media, isNew } of items) {
    const kind = laneOf(file);
    const audioLane = AUDIO_LANES.has(kind);
    if (audioLane ? !media.hasAudio : !(media.hasVideo || media.kind === 'image')) { toast(`${media.name} has no ${audioLane ? 'sound' : 'picture'} for the ${LANE_LABEL[kind]} lane`, 'error'); continue; }
    const ops: Op[] = [];
    if (isNew && !work.media[media.id]) ops.push({ op: 'addMedia', media });
    const lane = ensureLane(work, kind);
    ops.push(...lane.ops);
    if (ops.length) work = applyOps(work, ops).doc;
    const laneNow = work.lanes.find((l) => l.id === lane.laneId)!;
    const start = cursor.get(lane.laneId) ?? (placement.mode === 'end' ? laneNow.clips.reduce((t, c) => Math.max(t, clipEnd(c)), 0) : placement.mode === 'at' ? placement.t : getEdit().t);
    const out = media.kind === 'image' ? 3_000_000 : media.durationUs;
    const clip = newClip({ kind: 'media', mediaId: media.id, start, in: 0, out, name: media.name, audio: media.hasAudio ? defaultAudio() : undefined, fit: kind === 'screen' ? 'contain' : 'cover' });
    const ins = insertClipOps(work, lane.laneId, clip, false);
    work = applyOps(work, ins).doc;
    all.push(...ops, ...ins);
    cursor.set(lane.laneId, start + out);
    added.push(clip.id);
    lanesUsed.add(kind);
  }
  if (!added.length) return [];
  const label = added.length === 1 ? `Add ${items[0]!.media.name}` : `Add ${added.length} files`;
  if (!useProject.getState().apply(all, label)) return [];
  setEdit({ selection: added });
  toast(`Added ${added.length === 1 ? items[0]!.media.name : `${added.length} files`} to ${[...lanesUsed].map((k) => LANE_LABEL[k]).join(', ')}`, 'ok');
  return added;
}

/** Bring files into the project's Media bin without touching the timeline (one undo step). */
export async function importFiles(files: PickedFile[]): Promise<MediaRef[]> {
  if (!files.length) return [];
  const { items, failed } = await resolve(files, (f) => { const k = fileKindOf(fileName(f.path)); const g = k ? guessRole(f.rel, k) : null; return g?.role; });
  for (const f of failed) toast(`Could not import ${f}`, 'error');
  const fresh = items.filter((i) => i.isNew);
  if (fresh.length) useProject.getState().apply(fresh.map((i) => ({ op: 'addMedia', media: i.media }) as Op), `Import ${fresh.length} item${fresh.length > 1 ? 's' : ''}`);
  if (fresh.length) toast(`Imported ${fresh.length} item${fresh.length > 1 ? 's' : ''}`, 'ok');
  else if (items.length) toast(items.length > 1 ? 'Already in this project' : `${items[0]!.media.name} is already in this project`, 'info');
  return fresh.map((i) => i.media);
}

/** Every media file below a folder (up to 200), for the folder actions. */
export async function filesIn(dir: string): Promise<PickedFile[]> {
  const r = await invoke('files:search', { dir, q: '', limit: 200 });
  if (r.truncated) toast('Only the first 200 files in that folder are used.', 'info');
  return r.results.map((e) => ({ path: e.path, rel: e.rel }));
}
