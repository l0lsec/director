import {
  splitOps, splitAllAtOps, deleteClipsOps, rippleDeleteRangeOps, trimOps, moveClipOps, duplicateClipOps, setSpeedOps,
  detachAudioOps, insertClipOps, newClip, clipEnd, clipDuration, findClip, laneOfKind, timelineDuration, uid, defaultAudio,
  frameDurationExact, snapToFrame, AUDIO_LANES, type Op, type Project, type MediaRef, type LaneKind, type Clip,
} from '@director/engine';
import { useProject } from '../project/store';
import { getEdit, setEdit } from './store';
import { seek, togglePlay, pause, getPlayer } from './player';
import { registerCommands, type Command } from '../palette/registry';
import { useShell } from '../../shell/store';

const doc = (): Project | null => useProject.getState().doc;
const apply = (ops: Op[], label: string) => useProject.getState().apply(ops, label);
const frame = () => { const d = doc(); return d ? Math.round(frameDurationExact(d.canvas.fps)) : 33_333; };
const sel = () => getEdit().selection.filter((id) => !!(doc() && findClip(doc()!, id)));

export function laneForMedia(d: Project, m: MediaRef): string {
  const kind: LaneKind = m.role === 'camera' ? 'camera' : m.role === 'screen' ? 'screen' : m.kind === 'audio' ? (m.role === 'sfx' ? 'sfx' : m.role === 'mic' ? 'voice' : 'music') : m.kind === 'image' ? 'broll' : 'broll';
  return (laneOfKind(d, kind) ?? d.lanes[0]!).id;
}

/** Add media to the timeline at time t (or the playhead) on its natural lane. */
export function addMediaToTimeline(m: MediaRef, at?: number, laneId?: string): boolean {
  const d = doc();
  if (!d) return false;
  const lane = laneId ?? laneForMedia(d, m);
  const start = at ?? getEdit().t;
  const isAudioLane = AUDIO_LANES.has(d.lanes.find((l) => l.id === lane)!.kind);
  const out = m.kind === 'image' ? 3_000_000 : m.durationUs;
  const clip = newClip({ kind: 'media', mediaId: m.id, start, in: 0, out, name: m.name, audio: m.hasAudio ? defaultAudio() : undefined, fit: m.role === 'screen' ? 'contain' : 'cover' });
  if (isAudioLane && !m.hasAudio) return false;
  const ops: Op[] = [];
  if (!d.media[m.id]) ops.push({ op: 'addMedia', media: m });
  const after = ops.length ? (useProject.getState().doc ? { ...d, media: { ...d.media, [m.id]: m } } : d) : d;
  ops.push(...insertClipOps(after, lane, clip, false));
  const ok = apply(ops, `Add ${m.name}`);
  if (ok) setEdit({ selection: [clip.id] });
  return ok;
}

export function splitAtPlayhead(): void {
  const d = doc(); if (!d) return;
  const t = snapToFrame(getEdit().t, d.canvas.fps);
  const s = sel();
  const ops = s.length ? splitOps(d, s, t) : splitAllAtOps(d, t);
  if (ops.length) apply(ops, 'Split');
}

export function deleteSelection(ripple = getEdit().ripple): void {
  const d = doc(); const s = sel(); if (!d || !s.length) return;
  if (apply(deleteClipsOps(d, s, ripple), ripple ? 'Ripple delete' : 'Delete')) setEdit({ selection: [] });
}

export function deleteRange(from: number, to: number): void {
  const d = doc(); if (!d || to <= from) return;
  apply(rippleDeleteRangeOps(d, from, to), 'Delete range');
}

export function nudgeSelection(frames: number): void {
  const d = doc(); const s = sel(); if (!d || !s.length) return;
  const loc = findClip(d, s[0]!);
  if (!loc) return;
  apply(moveClipOps(d, loc.clip.id, loc.lane.id, Math.max(0, loc.clip.start + frames * frame())), 'Nudge');
}

export function trimToPlayhead(edge: 'start' | 'end'): void {
  const d = doc(); const s = sel(); if (!d || !s.length) return;
  apply(trimOps(d, s[0]!, edge, getEdit().t, { ripple: getEdit().ripple }), edge === 'start' ? 'Trim start' : 'Trim end');
}

export function duplicateSelection(): void {
  const d = doc(); const s = sel(); if (!d || !s.length) return;
  apply(duplicateClipOps(d, s[0]!), 'Duplicate');
}

export function setSpeed(rate: number): void {
  const d = doc(); const s = sel(); if (!d || !s.length) return;
  apply(setSpeedOps(d, s[0]!, rate, getEdit().ripple), `Speed ${rate}x`);
}

export function detachAudio(): void {
  const d = doc(); const s = sel(); if (!d || !s.length) return;
  const voice = laneOfKind(d, 'voice');
  if (voice) apply(detachAudioOps(d, s[0]!, voice.id), 'Detach audio');
}

export function selectAll(): void { const d = doc(); if (d) setEdit({ selection: d.lanes.flatMap((l) => l.clips.map((c) => c.id)) }); }

export function addText(content = 'Your title', laneKind: LaneKind = 'titles', extra: Partial<Clip> = {}): void {
  const d = doc(); if (!d) return;
  const lane = laneOfKind(d, laneKind) ?? d.lanes[0]!;
  const clip = newClip({ kind: 'text', start: getEdit().t, in: 0, out: 3_000_000, name: content, text: { content, font: 'Inter', size: 96, weight: 900, color: '#ffffff', align: 'center', lineHeight: 1.05, maxWidth: 0.86, stroke: { color: '#000000', width: 6 }, animationIn: 'pop', animationOut: 'fade', animationDuration: 250_000 }, ...extra });
  if (apply(insertClipOps(d, lane.id, clip, false), 'Add text')) setEdit({ selection: [clip.id] });
}

export function jumpEdit(dir: 1 | -1): void {
  const d = doc(); if (!d) return;
  const t = getEdit().t;
  const edges = new Set<number>([0, timelineDuration(d)]);
  for (const l of d.lanes) for (const c of l.clips) { edges.add(c.start); edges.add(clipEnd(c)); }
  for (const m of d.markers) edges.add(m.t);
  const sorted = [...edges].sort((a, b) => a - b);
  const next = dir > 0 ? sorted.find((x) => x > t + 1) : [...sorted].reverse().find((x) => x < t - 1);
  if (next != null) seek(next);
}

let shuttle = 0;
export function jkl(key: 'J' | 'K' | 'L'): void {
  const p = getPlayer();
  if (!p) return;
  if (key === 'K') { shuttle = 0; pause(); return; }
  if (key === 'L') { shuttle = Math.max(1, shuttle + 1); if (!p.isPlaying) void p.play(); }
  if (key === 'J') { pause(); seek(getEdit().t - frame() * 15); }
}

export function addMarker(): void {
  const d = doc(); if (!d) return;
  apply([{ op: 'addMarker', marker: { id: uid('mk'), t: getEdit().t, kind: 'note', label: 'Marker' } }], 'Add marker');
}

export function zoomBy(f: number): void { setEdit({ zoom: Math.max(4, Math.min(2000, getEdit().zoom * f)) }); }
export function zoomToFit(width: number): void { const d = doc(); if (!d) return; const dur = Math.max(1, timelineDuration(d) / 1e6); setEdit({ zoom: Math.max(4, (width - 40) / dur), scrollX: 0 }); }

export function clipLength(c: Clip): number { return clipDuration(c); }

/** Every edit command, with default shortcuts. The keymap presets remap these ids. */
export const EDIT_COMMANDS: Command[] = [
  { id: 'edit.play', title: 'Play / pause', group: 'Playback', description: 'Toggle playback', shortcut: 'Space', run: togglePlay },
  { id: 'edit.split', title: 'Split at playhead', group: 'Edit', description: 'Cut selected clips (or all) at the playhead', shortcut: 'Cmd+B', run: splitAtPlayhead },
  { id: 'edit.delete', title: 'Delete', group: 'Edit', description: 'Delete selected clips and close the gap', shortcut: 'Delete', run: () => deleteSelection() },
  { id: 'edit.lift', title: 'Delete and leave gap', group: 'Edit', description: 'Delete without moving later clips', shortcut: 'Shift+Delete', run: () => deleteSelection(false) },
  { id: 'edit.undo', title: 'Undo', group: 'Edit', description: 'Undo the last change', shortcut: 'Cmd+Z', run: () => useProject.getState().undo() },
  { id: 'edit.redo', title: 'Redo', group: 'Edit', description: 'Redo the last undone change', shortcut: 'Cmd+Shift+Z', run: () => useProject.getState().redo() },
  { id: 'edit.selectAll', title: 'Select all', group: 'Edit', description: 'Select every clip', shortcut: 'Cmd+A', run: selectAll },
  { id: 'edit.duplicate', title: 'Duplicate', group: 'Edit', description: 'Duplicate the selected clip after itself', shortcut: 'Cmd+D', run: duplicateSelection },
  { id: 'edit.trimStart', title: 'Trim start to playhead', group: 'Edit', description: 'Q in Premiere', shortcut: 'Q', run: () => trimToPlayhead('start') },
  { id: 'edit.trimEnd', title: 'Trim end to playhead', group: 'Edit', description: 'W in Premiere', shortcut: 'W', run: () => trimToPlayhead('end') },
  { id: 'edit.nudgeLeft', title: 'Nudge left one frame', group: 'Edit', description: 'Move selected clip earlier', shortcut: 'Alt+Left', run: () => nudgeSelection(-1) },
  { id: 'edit.nudgeRight', title: 'Nudge right one frame', group: 'Edit', description: 'Move selected clip later', shortcut: 'Alt+Right', run: () => nudgeSelection(1) },
  { id: 'edit.detach', title: 'Detach audio', group: 'Edit', description: 'Move a clip’s audio to the Voice lane', shortcut: 'Cmd+Shift+D', run: detachAudio },
  { id: 'edit.marker', title: 'Add marker', group: 'Edit', description: 'Marker at the playhead', shortcut: 'M', run: addMarker },
  { id: 'edit.text', title: 'Add text', group: 'Edit', description: 'Title at the playhead', shortcut: 'T', run: () => addText() },
  { id: 'edit.toolSelect', title: 'Select tool', group: 'Tools', description: 'Move and trim clips', shortcut: 'V', run: () => setEdit({ tool: 'select' }) },
  { id: 'edit.toolBlade', title: 'Blade tool', group: 'Tools', description: 'Click a clip to cut it', shortcut: 'B', run: () => setEdit({ tool: 'blade' }) },
  { id: 'edit.toolSlip', title: 'Slip tool', group: 'Tools', description: 'Drag to change a clip’s source range', shortcut: 'Y', run: () => setEdit({ tool: 'slip' }) },
  { id: 'edit.toolRoll', title: 'Roll tool', group: 'Tools', description: 'Drag an edit point between clips', shortcut: 'N', run: () => setEdit({ tool: 'roll' }) },
  { id: 'edit.snap', title: 'Toggle snapping', group: 'Timeline', description: 'Snap to clips, playhead and markers', shortcut: 'S', run: () => setEdit({ snapping: !getEdit().snapping }) },
  { id: 'edit.ripple', title: 'Toggle ripple', group: 'Timeline', description: 'Close gaps automatically', shortcut: 'Cmd+R', run: () => setEdit({ ripple: !getEdit().ripple }) },
  { id: 'edit.zoomIn', title: 'Zoom in', group: 'Timeline', description: 'Zoom the timeline in', shortcut: 'Cmd+=', run: () => zoomBy(1.4) },
  { id: 'edit.zoomOut', title: 'Zoom out', group: 'Timeline', description: 'Zoom the timeline out', shortcut: 'Cmd+-', run: () => zoomBy(1 / 1.4) },
  { id: 'edit.zoomFit', title: 'Zoom to fit', group: 'Timeline', description: 'Show the whole timeline', shortcut: 'Shift+Z', run: () => zoomToFit(window.innerWidth - 120) },
  { id: 'edit.prevEdit', title: 'Previous edit point', group: 'Playback', description: 'Jump to the previous cut or marker', shortcut: 'Up', run: () => jumpEdit(-1) },
  { id: 'edit.nextEdit', title: 'Next edit point', group: 'Playback', description: 'Jump to the next cut or marker', shortcut: 'Down', run: () => jumpEdit(1) },
  { id: 'edit.frameBack', title: 'Back one frame', group: 'Playback', description: 'Step one frame back', shortcut: 'Left', run: () => { pause(); seek(getEdit().t - frame()); } },
  { id: 'edit.frameForward', title: 'Forward one frame', group: 'Playback', description: 'Step one frame forward', shortcut: 'Right', run: () => { pause(); seek(getEdit().t + frame()); } },
  { id: 'edit.start', title: 'Go to start', group: 'Playback', description: 'Playhead to the beginning', shortcut: 'Home', run: () => seek(0) },
  { id: 'edit.end', title: 'Go to end', group: 'Playback', description: 'Playhead to the end', shortcut: 'End', run: () => { const d = doc(); if (d) seek(timelineDuration(d)); } },
  { id: 'edit.shuttleBack', title: 'Shuttle back', group: 'Playback', description: 'Play backward; press again to go faster', shortcut: 'J', run: () => jkl('J') },
  { id: 'edit.shuttleStop', title: 'Shuttle stop', group: 'Playback', description: 'Pause shuttle playback', shortcut: 'K', run: () => jkl('K') },
  { id: 'edit.shuttleForward', title: 'Shuttle forward', group: 'Playback', description: 'Play forward; press again to go faster', shortcut: 'L', run: () => jkl('L') },
  { id: 'edit.inPoint', title: 'Mark in', group: 'Playback', description: 'Set the in point', shortcut: 'I', run: () => setEdit({ inPoint: getEdit().t }) },
  { id: 'edit.outPoint', title: 'Mark out', group: 'Playback', description: 'Set the out point', shortcut: 'O', run: () => setEdit({ outPoint: getEdit().t }) },
  { id: 'edit.deleteInOut', title: 'Delete between in and out', group: 'Edit', description: 'Ripple delete the marked range on every lane', shortcut: 'Cmd+Shift+X', run: () => { const e = getEdit(); if (e.inPoint != null && e.outPoint != null) deleteRange(Math.min(e.inPoint, e.outPoint), Math.max(e.inPoint, e.outPoint)); } },
  { id: 'edit.loop', title: 'Toggle loop playback', group: 'Playback', description: 'Loop at the end', shortcut: 'Cmd+L', run: () => { const p = getPlayer(); setEdit({ loop: !getEdit().loop }); if (p) p.loop = getEdit().loop; } },
  { id: 'edit.save', title: 'Save now', group: 'File', description: 'Write a full snapshot (changes autosave anyway)', shortcut: 'Cmd+S', run: async () => { await useProject.getState().flush(); useShell.getState().toast('Saved', 'ok'); } },
];

registerCommands(EDIT_COMMANDS);

(globalThis as Record<string, unknown>).__directorEditCmd = { addMediaToTimeline, splitAtPlayhead, deleteSelection, deleteRange, nudgeSelection, trimToPlayhead, duplicateSelection, setSpeed, detachAudio, selectAll, addText, jumpEdit, addMarker, zoomBy, zoomToFit, seek, getEdit, setEdit };
