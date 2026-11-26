import type { Clip, Project, Speed } from '../schema/project';
import type { Op } from './primitives';
import { OpError } from './primitives';
import { Tx, splitOps, insertClipOps } from './commands';
import { clipEnd, clipDuration, findClip, newClip, sourceTimeAt, uid, anim } from '../model';

export const RAMP_PRESETS: Record<string, { label: string; points: Array<{ at: number; rate: number }> }> = {
  montage: { label: 'Montage', points: [{ at: 0, rate: 1 }, { at: 0.3, rate: 3 }, { at: 0.7, rate: 3 }, { at: 1, rate: 1 }] },
  hero: { label: 'Hero moment', points: [{ at: 0, rate: 1 }, { at: 0.4, rate: 0.3 }, { at: 0.6, rate: 0.3 }, { at: 1, rate: 1 }] },
  bullet: { label: 'Bullet time', points: [{ at: 0, rate: 3 }, { at: 0.5, rate: 0.25 }, { at: 1, rate: 3 }] },
  'ease-in': { label: 'Speed up', points: [{ at: 0, rate: 0.5 }, { at: 1, rate: 2 }] },
  'ease-out': { label: 'Slow down', points: [{ at: 0, rate: 2 }, { at: 1, rate: 0.5 }] },
};

/** Apply a speed-ramp preset (or back to 1x with null). With ripple, later clips on the lane follow. */
export function setRampOps(doc: Project, clipId: string, preset: string | null, ripple: boolean): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const tx = new Tx(doc);
  const before = clipEnd(loc.clip);
  const speed: Speed = preset ? { kind: 'ramp', points: RAMP_PRESETS[preset]!.points, preservePitch: false } : { kind: 'constant', rate: 1, preservePitch: true };
  tx.do({ op: 'updateClip', id: clipId, patch: { speed } });
  const after = clipEnd(findClip(tx.doc, clipId)!.clip);
  if (ripple && after !== before) for (const c of tx.doc.lanes.find((l) => l.id === loc.lane.id)!.clips.filter((c) => c.start >= before && c.id !== clipId)) tx.do({ op: 'updateClip', id: c.id, patch: { start: c.start + after - before } });
  return tx.ops;
}

/** Hold the frame at `at` for `holdUs`, pushing everything later (all lanes) to make room. */
export function freezeFrameOps(doc: Project, clipId: string, at: number, holdUs = 1_000_000): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  const c = loc.clip;
  if (at <= c.start || at >= clipEnd(c)) throw new OpError('playhead must be inside the clip', 'RANGE');
  const tx = new Tx(doc);
  for (const op of splitOps(tx.doc, [clipId], at)) tx.do(op);
  const frozen = newClip({
    kind: 'media', mediaId: c.mediaId, start: at, in: 0, out: holdUs, freezeAt: sourceTimeAt(c, at), name: `${c.name ?? 'Clip'} (freeze)`,
    transform: c.transform, effects: c.effects, fit: c.fit, audio: c.audio ? { ...c.audio, muted: true } : undefined,
  });
  for (const op of insertClipOps(tx.doc, loc.lane.id, frozen, true)) tx.do(op);
  return tx.ops;
}

export function reverseOps(doc: Project, clipId: string): Op[] {
  const loc = findClip(doc, clipId);
  if (!loc) throw new OpError(`clip ${clipId} not found`, 'NOT_FOUND');
  return [{ op: 'updateClip', id: clipId, patch: { reverse: !loc.clip.reverse } }];
}

export type PipLayout = 'full' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'split-top' | 'split-bottom';

/** Transform for a picture-in-picture layout on the project canvas. */
export function pipTransform(layout: PipLayout, canvas: { width: number; height: number }, margin = 0.04): Pick<Clip, 'transform' | 'fit'> {
  const W = canvas.width, H = canvas.height;
  const t = (x: number, y: number, s: number) => ({ x: anim(Math.round(x)), y: anim(Math.round(y)), scale: anim(s), rotation: anim(0), opacity: anim(1), crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false });
  const s = 0.36;
  const dx = W / 2 - (W * s) / 2 - W * margin, dy = H / 2 - (H * s) / 2 - H * margin;
  switch (layout) {
    case 'top-left': return { transform: t(-dx, -dy, s), fit: 'cover' };
    case 'top-right': return { transform: t(dx, -dy, s), fit: 'cover' };
    case 'bottom-left': return { transform: t(-dx, dy, s), fit: 'cover' };
    case 'bottom-right': return { transform: t(dx, dy, s), fit: 'cover' };
    case 'split-top': return { transform: { ...t(0, -H / 4, 1), crop: { left: 0, top: 0.25, right: 0, bottom: 0.25 } }, fit: 'cover' };
    case 'split-bottom': return { transform: { ...t(0, H / 4, 1), crop: { left: 0, top: 0.25, right: 0, bottom: 0.25 } }, fit: 'cover' };
    default: return { transform: t(0, 0, 1), fit: 'cover' };
  }
}

export function pipOps(doc: Project, clipId: string, layout: PipLayout): Op[] {
  const p = pipTransform(layout, doc.canvas);
  return [{ op: 'updateClip', id: clipId, patch: { transform: p.transform, fit: p.fit } }];
}

export interface FaceSample { t: number; faces: Array<{ x: number; y: number; w: number; h: number; c?: number }> }

/**
 * Keyframes for transform.x that keep the (largest) face horizontally centred when a wide source is
 * cropped to a narrow canvas. Smoothed, clamped so the image always covers the canvas.
 */
export function reframeKeyframes(track: FaceSample[], clip: Clip, src: { width: number; height: number }, canvas: { width: number; height: number }, stepUs = 250_000): Clip['transform']['x'] {
  const cover = Math.max(canvas.width / src.width, canvas.height / src.height);
  const scaled = src.width * cover * (clip.transform.scale.value || 1);
  const maxShift = Math.max(0, (scaled - canvas.width) / 2);
  const rate = clip.speed.kind === 'constant' ? clip.speed.rate : 1;
  // Face center in source-normalized x over source time (seconds), largest face per sample.
  const pts = track
    .map((s) => { const f = [...s.faces].sort((a, b) => b.w * b.h - a.w * a.h)[0]; return f ? { t: s.t * 1e6, x: f.x + f.w / 2 } : null; })
    .filter((p): p is { t: number; x: number } => !!p);
  if (!pts.length) return clip.transform.x;
  const xAtSrc = (t: number) => {
    // Moving average over +-0.4 s to remove jitter.
    const near = pts.filter((p) => Math.abs(p.t - t) <= 400_000);
    if (near.length) return near.reduce((n, p) => n + p.x, 0) / near.length;
    return pts.reduce((best, p) => (Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best)).x;
  };
  const kfs: Array<{ t: number; v: number; ease: 'linear' }> = [];
  const dur = clipDuration(clip);
  for (let rel = 0; rel <= dur; rel += stepUs) {
    const srcT = clip.reverse ? clip.out - rel * rate : clip.in + rel * rate;
    const fx = xAtSrc(srcT);
    // Shift so the face's x lands on the canvas centre.
    const shift = (0.5 - fx) * scaled;
    kfs.push({ t: rel, v: Math.round(Math.max(-maxShift, Math.min(maxShift, shift))), ease: 'linear' });
  }
  return { value: kfs[0]?.v ?? 0, keyframes: kfs };
}

