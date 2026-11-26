// Speaker layout: turn a shot plan (who to show when) into clips on lanes above a split-screen or single-camera clip.
// The original clip stays underneath untouched and keeps playing the sound; each shot is a muted copy of the same
// source, cropped to one person's panel and framed on their face.
import type { Clip, Effect, Lane, Op, Project } from '..';
import { clipEnd, findClip, newClip, newLane, uid, anim, defaultAudio } from '../model';
import { OpError } from './primitives';
import { Tx } from './commands';

interface Rect { x: number; y: number; w: number; h: number }
/** A shot in source µs; face/faces (optional) frame it on where the faces are during that shot. */
type Shot = { kind: 'solo'; panel: number; start: number; end: number; zoom: number; face?: Rect } | { kind: 'all'; start: number; end: number; faces?: Array<Rect | null> };

export interface SpeakerLayoutInput {
  /** People's panels in the source (normalized, left to right). */
  panels: Rect[];
  /** Median face box per panel (normalized source coordinates). */
  faces: Array<Rect | null>;
  /** Shots in source microseconds. */
  shots: Shot[];
  /** Names for the panels, used in clip names. */
  names?: string[];
  /** Extra effects per panel (for example a colour correction for one camera), copied onto every shot of that panel. */
  effects?: Record<number, Effect[]>;
  /** Where the face's center sits vertically in a shot, as a fraction of its height from the top (default 0.45). */
  faceY?: number;
  /** Close shots start this much in from the whole panel, leaving room to center a face near its edge (default 1.08). */
  soloZoom?: number;
}

export const SPEAKER_LANE = 'Speakers';

/** Crop and transform that show `win` (a source rectangle in pixels) filling `slot` (canvas pixels). */
export function windowTransform(win: { x: number; y: number; w: number; h: number }, src: { width: number; height: number }, canvas: { width: number; height: number }, slot: { x: number; y: number; w: number; h: number }): Pick<Clip, 'transform' | 'fit'> {
  const sw = src.width, sh = src.height, W = canvas.width, H = canvas.height;
  const b = Math.max(W / sw, H / sh);
  const k = slot.h / (win.h * b);
  const crop = { left: win.x / sw, top: win.y / sh, right: 1 - (win.x + win.w) / sw, bottom: 1 - (win.y + win.h) / sh };
  const x = slot.x + slot.w / 2 - W / 2 - ((crop.left - crop.right) / 2) * sw * b * k;
  const y = slot.y + slot.h / 2 - H / 2 - ((crop.top - crop.bottom) / 2) * sh * b * k;
  const r = (v: number) => Math.round(v * 1e5) / 1e5;
  return {
    fit: 'cover',
    transform: { x: anim(Math.round(x * 10) / 10), y: anim(Math.round(y * 10) / 10), scale: anim(r(k)), rotation: anim(0), opacity: anim(1), crop: { left: r(crop.left), top: r(crop.top), right: r(crop.right), bottom: r(crop.bottom) }, flipH: false, flipV: false },
  };
}

/** The source window (pixels) inside a panel with the slot's shape, `zoom` times closer, centred on the face. */
export function faceWindow(panel: Rect, face: Rect | null, src: { width: number; height: number }, slotAspect: number, zoom: number, faceY = 0.45) {
  const px = panel.x * src.width, py = panel.y * src.height, pw = panel.w * src.width, ph = panel.h * src.height;
  let w: number, h: number;
  if (pw / ph > slotAspect) { h = ph; w = ph * slotAspect; } else { w = pw; h = pw / slotAspect; }
  w /= Math.max(1, zoom); h /= Math.max(1, zoom);
  const fx = face ? (face.x + face.w / 2) * src.width : px + pw / 2;
  const fy = face ? (face.y + face.h / 2) * src.height : py + ph / 2;
  const x = Math.min(px + pw - w, Math.max(px, fx - w / 2));
  const y = Math.min(py + ph - h, Math.max(py, fy - h * faceY));
  return { x, y, w, h };
}

/**
 * Ops that lay the shots over clip `clipId`: lanes named "Speakers" (one per person shown at once) are added above the
 * clip's lane, or reused, and earlier speaker-layout clips from the same clip in the range are replaced.
 */
export function speakerLayoutOps(doc: Project, clipId: string, input: SpeakerLayoutInput): { ops: Op[]; clips: number; lanes: string[] } {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const base = loc.clip;
  if (base.kind !== 'media' || !base.mediaId) throw new OpError('speaker layout needs a video clip', 'INVALID');
  if (base.speed.kind !== 'constant' || base.speed.rate !== 1 || base.reverse) throw new OpError('speaker layout needs a clip at normal speed, not reversed', 'INVALID');
  const media = doc.media[base.mediaId];
  if (!media?.width || !media.height) throw new OpError('the clip has no picture size', 'INVALID');
  const src = { width: media.width, height: media.height };
  const W = doc.canvas.width, H = doc.canvas.height;
  const frame = (1e6 * doc.canvas.fps.den) / doc.canvas.fps.num;
  const toTl = (s: number) => Math.round(Math.round((base.start + (s - base.in)) / frame) * frame);
  const P = input.panels.length;
  const shots = input.shots
    .map((s) => ({ ...s, start: Math.max(base.in, s.start), end: Math.min(base.out, s.end) }))
    .filter((s) => s.end > s.start);
  const rangeA = shots.length ? toTl(shots[0]!.start) : base.start, rangeB = shots.length ? toTl(shots[shots.length - 1]!.end) : base.start;

  const tx = new Tx(doc);
  // Lanes: reuse "Speakers", "Speakers 2", ... or add them just above the clip's lane.
  const needLanes = Math.max(1, shots.some((s) => s.kind === 'all') ? P : 1);
  const laneIds: string[] = [];
  for (let i = 0; i < needLanes; i++) {
    const name = i === 0 ? SPEAKER_LANE : `${SPEAKER_LANE} ${i + 1}`;
    const found = tx.doc.lanes.find((l) => l.name === name);
    if (found) { laneIds.push(found.id); continue; }
    const lane: Lane = newLane('camera', { name });
    const at = tx.doc.lanes.findIndex((l) => l.id === loc.lane.id);
    // Lanes earlier in the list draw on top; the first speaker lane sits right above the clip's lane, later ones above it.
    tx.do({ op: 'addLane', lane, index: Math.max(0, at) });
    laneIds.push(lane.id);
  }
  // Replace earlier layout clips made from this clip within the range.
  for (const l of tx.doc.lanes) for (const c of l.clips) {
    const m = c.meta as { speakerLayout?: string } | undefined;
    if (m?.speakerLayout === base.id && c.start < rangeB && clipEnd(c) > rangeA) tx.do({ op: 'removeClip', id: c.id });
  }
  const names = input.names ?? [];
  const label = (p: number) => names[p] || `Person ${p + 1}`;
  let made = 0;
  const add = (laneId: string, s: { start: number; end: number }, place: Pick<Clip, 'transform' | 'fit'>, panel: number, name: string) => {
    const start = toTl(s.start), end = toTl(s.end);
    if (end - start < frame / 2) return;
    const clip = newClip({
      kind: 'media', mediaId: base.mediaId, start, in: base.in + (start - base.start), out: base.in + (end - base.start), name,
      ...place, audio: { ...defaultAudio(), muted: true },
      effects: [...base.effects.filter((e) => e.type !== 'zoom' && e.type !== 'shake').map((e) => ({ ...structuredClone(e), id: uid('fx') })), ...(input.effects?.[panel] ?? []).map((e) => ({ ...structuredClone(e), id: uid('fx') }))],
      meta: { speakerLayout: base.id, panel },
    });
    tx.do({ op: 'addClip', laneId, clip });
    made++;
  };
  for (const s of shots) {
    if (s.kind === 'solo') {
      const win = faceWindow(input.panels[s.panel]!, s.face ?? input.faces[s.panel] ?? null, src, W / H, s.zoom * (input.soloZoom ?? 1.08), input.faceY);
      add(laneIds[0]!, s, windowTransform(win, src, { width: W, height: H }, { x: 0, y: 0, w: W, h: H }), s.panel, `${label(s.panel)}${s.zoom > 1 ? ' (close)' : ''}`);
    } else {
      for (let p = 0; p < P; p++) {
        const slot = { x: (W * p) / P, y: 0, w: W / P, h: H };
        const win = faceWindow(input.panels[p]!, s.faces?.[p] ?? input.faces[p] ?? null, src, slot.w / slot.h, 1, input.faceY);
        add(laneIds[p] ?? laneIds[0]!, s, windowTransform(win, src, { width: W, height: H }, slot), p, `${label(p)} (side by side)`);
      }
    }
  }
  return { ops: tx.ops, clips: made, lanes: laneIds };
}
