import type { MediaRef, Project } from '../schema/project';
import type { Op } from '../ops/primitives';
import type { Take } from './index';
import { newClip, laneOfKind, uid, timelineDuration, defaultAudio } from '../model';

export interface TakeMedia { camera: MediaRef; screen?: MediaRef }

/**
 * Ops that place a recorded take on the timeline: camera video (its audio muted) with the same
 * audio linked on the Voice lane, the screen recording on the Screen lane at its measured offset,
 * and the take's retake/cue markers. Everything is appended after existing content.
 */
export function takeToOps(doc: Project, take: Take, media: TakeMedia, opts: { at?: number } = {}): Op[] {
  const ops: Op[] = [];
  const at = opts.at ?? timelineDuration(doc);
  const cam = laneOfKind(doc, 'camera');
  const voice = laneOfKind(doc, 'voice');
  const scr = laneOfKind(doc, 'screen');
  if (!cam || !voice) throw new Error('project needs Camera and Voice lanes');
  for (const m of [media.camera, media.screen]) if (m && !doc.media[m.id]) ops.push({ op: 'addMedia', media: m });
  const offset = media.screen ? take.clock.screenOffsetUs ?? 0 : 0;
  // If the screen started before the camera, push the camera right so both stay in sync.
  const camStart = at + Math.max(0, -offset);
  const link = uid('link');
  const camDur = media.camera.durationUs;
  ops.push({ op: 'addClip', laneId: cam.id, clip: newClip({ kind: 'media', mediaId: media.camera.id, start: camStart, in: 0, out: camDur, linkGroup: link, audio: { ...defaultAudio(), muted: true }, name: take.title }) });
  // Positive audioOffsetUs means sound arrived late (measured once with a clap); pull the voice earlier.
  const ao = take.clock.audioOffsetUs ?? 0;
  if (media.camera.hasAudio) ops.push({ op: 'addClip', laneId: voice.id, clip: newClip({ kind: 'media', mediaId: media.camera.id, start: camStart + Math.max(0, -ao), in: Math.max(0, ao), out: camDur, linkGroup: link, audio: defaultAudio(), name: `${take.title} (voice)` }) });
  if (media.screen && scr) ops.push({ op: 'addClip', laneId: scr.id, clip: newClip({ kind: 'media', mediaId: media.screen.id, start: camStart + offset, in: 0, out: media.screen.durationUs, linkGroup: link, audio: media.screen.hasAudio ? { ...defaultAudio(), muted: true } : undefined, name: `${take.title} (screen)` }) });
  for (const m of take.markers) {
    if (m.kind === 'pause' || m.kind === 'resume') continue;
    ops.push({ op: 'addMarker', marker: { id: uid('mk'), t: camStart + m.t, kind: m.kind === 'retake' ? 'retake' : m.kind === 'cue' ? 'cue' : m.kind === 'good' ? 'good' : m.kind === 'bad' ? 'bad' : 'note', label: m.label, data: { takeId: take.id, ...(m.line != null ? { line: m.line } : {}), ...(m.wordIndex != null ? { wordIndex: m.wordIndex } : {}) } } });
  }
  if (take.script?.text && !doc.scriptText) {
    const ref = take.script.scriptId && take.script.version != null ? { scriptRef: { scriptId: take.script.scriptId, version: take.script.version } } : {};
    ops.push({ op: 'setMeta', patch: { scriptText: take.script.text, ...ref } });
  }
  return ops;
}
