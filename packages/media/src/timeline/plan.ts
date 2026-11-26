import {
  AUDIO_LANES, clipDuration, clipEnd, evalAnim, sourceTimeAt,
  type Clip, type Lane, type Project, type Effect, type Animatable,
} from '@director/engine';
import type { ColorAdjust, LayerDraw } from '../compositor/gl';

export interface VisualPlan {
  clip: Clip;
  lane: Lane;
  /** Time relative to the clip start (microseconds). */
  tRel: number;
  duration: number;
  kind: 'video' | 'image' | 'text' | 'shape';
  path?: string;
  /** Source time in seconds for video. */
  srcSec?: number;
  /** Person matte video for background removal (same timing as the source). */
  matte?: { path: string };
  /** Transition into this clip: 0..1 progress, or null. */
  transition: { type: string; progress: number } | null;
}

/** Visual clips active at time t, bottom-most first. */
export function planFrame(doc: Project, t: number): VisualPlan[] {
  const out: VisualPlan[] = [];
  const lanes = [...doc.lanes].reverse();
  const solo = doc.lanes.some((l) => l.solo && !AUDIO_LANES.has(l.kind));
  for (const lane of lanes) {
    if (AUDIO_LANES.has(lane.kind) || lane.hidden || (solo && !lane.solo)) continue;
    // Crossfades: during an incoming clip's dissolve, the previous clip keeps playing underneath
    // (from its media handle past its out point, or holding its last frame).
    for (let ci = 1; ci < lane.clips.length; ci++) {
      const inc = lane.clips[ci]!;
      const prev = lane.clips[ci - 1]!;
      const tr = inc.transitionIn;
      if (!tr || !inc.enabled || !prev.enabled || !['crossfade', 'dissolve', 'dip-black', 'dip-white'].includes(tr.type)) continue;
      if (Math.abs(clipEnd(prev) - inc.start) > 1000 || t < inc.start || t >= inc.start + tr.duration) continue;
      const rel = t - prev.start;
      if (prev.kind === 'media' && prev.mediaId) {
        const m = doc.media[prev.mediaId];
        if (!m || !m.hasVideo) continue;
        const rate = prev.speed.kind === 'constant' ? prev.speed.rate : 1;
        const handleEnd = m.kind === 'image' ? Infinity : m.durationUs - 1;
        const src = prev.reverse ? Math.max(0, prev.in - (t - clipEnd(prev)) * rate) : Math.min(handleEnd, prev.out + (t - clipEnd(prev)) * rate);
        out.push({ clip: prev, lane, tRel: Math.min(rel, clipDuration(prev) - 1), duration: clipDuration(prev), kind: m.kind === 'image' ? 'image' : 'video', path: m.proxyPath ?? m.path, srcSec: src / 1e6, transition: { type: `out:${tr.type}`, progress: (t - inc.start) / tr.duration } });
      } else if ((prev.kind === 'text' || prev.kind === 'caption') && prev.text) {
        out.push({ clip: prev, lane, tRel: Math.min(rel, clipDuration(prev) - 1), duration: clipDuration(prev), kind: 'text', transition: { type: `out:${tr.type}`, progress: (t - inc.start) / tr.duration } });
      }
    }
    for (const clip of lane.clips) {
      if (!clip.enabled || clip.start > t || clipEnd(clip) <= t) continue;
      const dur = clipDuration(clip);
      const tRel = t - clip.start;
      const tr = clip.transitionIn && tRel < clip.transitionIn.duration ? { type: clip.transitionIn.type, progress: tRel / clip.transitionIn.duration } : null;
      if (clip.kind === 'media' && clip.mediaId) {
        const m = doc.media[clip.mediaId];
        if (!m || !m.hasVideo) continue;
        if (m.kind === 'image') out.push({ clip, lane, tRel, duration: dur, kind: 'image', path: m.path, transition: tr });
        else {
          const mt = clip.effects.find((e) => e.type === 'matte' && e.enabled && typeof e.params.path === 'string');
          out.push({ clip, lane, tRel, duration: dur, kind: 'video', path: m.proxyPath && doc.settings ? m.proxyPath : m.path, srcSec: sourceTimeAt(clip, t) / 1e6, transition: tr, ...(mt ? { matte: { path: mt.params.path as string } } : {}) });
        }
      } else if ((clip.kind === 'text' || clip.kind === 'caption') && clip.text) {
        out.push({ clip, lane, tRel, duration: dur, kind: 'text', transition: tr });
      } else if (clip.kind === 'shape' && clip.shape) {
        out.push({ clip, lane, tRel, duration: dur, kind: 'shape', transition: tr });
      }
    }
  }
  return out;
}

const num = (v: Effect['params'][string] | undefined, tRel: number, fallback: number): number => {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  if (typeof v === 'object') return evalAnim(v as Animatable, tRel);
  return fallback;
};

export interface ResolvedEffects { color: ColorAdjust; lut?: string; lutStrength?: number; blur: number; zoom: number; shake: { x: number; y: number }; key?: LayerDraw['key']; mask?: LayerDraw['mask'] }

/** Evaluate a clip's effects stack at tRel. */
export function resolveEffects(clip: Clip, tRel: number): ResolvedEffects {
  const r: ResolvedEffects = { color: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, brightness: 0, vignette: 0 }, blur: 0, zoom: 1, shake: { x: 0, y: 0 } };
  for (const e of clip.effects) {
    if (!e.enabled) continue;
    const p = e.params;
    switch (e.type) {
      case 'color':
        r.color.exposure += num(p.exposure, tRel, 0); r.color.contrast += num(p.contrast, tRel, 0); r.color.saturation += num(p.saturation, tRel, 0);
        r.color.temperature += num(p.temperature, tRel, 0); r.color.tint += num(p.tint, tRel, 0); r.color.brightness += num(p.brightness, tRel, 0);
        break;
      case 'vignette': r.color.vignette += num(p.amount, tRel, 0.5); break;
      case 'lut': if (typeof p.path === 'string') { r.lut = p.path; r.lutStrength = num(p.strength, tRel, 1); } break;
      case 'blur': r.blur += num(p.radius, tRel, 10); break;
      case 'zoom': {
        // Punch-in: ramps from 1 to `amount` over `ramp` microseconds from `at` (and back after `until`, if set).
        const at = num(p.at, tRel, 0), ramp = Math.max(1, num(p.ramp, tRel, 120_000)), amount = num(p.amount, tRel, 1.15);
        const x = Math.min(1, Math.max(0, (tRel - at) / ramp));
        if (tRel >= at) {
          let k = 1 - Math.pow(1 - x, 3);
          // Optional release: eases back to 1 over `ramp` from `until`.
          if (p.until !== undefined) {
            const until = num(p.until, tRel, Infinity);
            if (tRel >= until) k *= Math.pow(1 - Math.min(1, (tRel - until) / ramp), 3);
          }
          r.zoom *= 1 + (amount - 1) * k;
        }
        break;
      }
      case 'shake': {
        const amp = num(p.amount, tRel, 12), f = num(p.frequency, tRel, 9);
        const s = tRel / 1e6;
        r.shake.x += amp * Math.sin(s * f * 6.283 + 1.3) * Math.sin(s * f * 2.1);
        r.shake.y += amp * Math.cos(s * f * 5.17) * Math.sin(s * f * 1.7 + 0.4);
        break;
      }
      case 'chromakey': {
        const hex = typeof p.color === 'string' ? p.color : '#00ff00';
        const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
        r.key = { color: c, similarity: num(p.similarity, tRel, 0.3), smoothness: num(p.smoothness, tRel, 0.1) };
        break;
      }
      case 'mask':
        r.mask = { kind: p.shape === 'ellipse' ? 'ellipse' : 'rect', x: num(p.x, tRel, 0), y: num(p.y, tRel, 0), w: num(p.w, tRel, 1), h: num(p.h, tRel, 1), feather: num(p.feather, tRel, 0.05), invert: p.invert === true };
        break;
    }
  }
  return r;
}

/** Transition-in modifiers on the incoming clip. */
export function transitionMods(tr: VisualPlan['transition'], W: number, H: number): { opacity: number; dx: number; dy: number; scale: number; blur: number; dip: [number, number, number] | null } {
  const m = { opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, dip: null as [number, number, number] | null };
  if (!tr) return m;
  const p = Math.max(0, Math.min(1, tr.progress));
  const e = 1 - Math.pow(1 - p, 3);
  switch (tr.type) {
    case 'crossfade': case 'dissolve': m.opacity = p; break;
    // Dips: the screen holds the dip color for the whole transition; the incoming clip fades up
    // over the second half while the outgoing one (drawn as out:...) fades down over the first.
    case 'dip-black': m.opacity = p < 0.5 ? 0 : (p - 0.5) * 2; m.dip = [0, 0, 0]; break;
    case 'dip-white': m.opacity = p < 0.5 ? 0 : (p - 0.5) * 2; m.dip = [1, 1, 1]; break;
    case 'out:dip-black': case 'out:dip-white': m.opacity = Math.max(0, 1 - p * 2); m.dip = tr.type === 'out:dip-white' ? [1, 1, 1] : [0, 0, 0]; break;
    case 'out:crossfade': case 'out:dissolve': break;
    case 'slide-left': m.dx = (1 - e) * W; break;
    case 'slide-up': m.dy = (1 - e) * H; break;
    case 'zoom': m.scale = 1.6 - 0.6 * e; m.opacity = p; break;
    case 'whip': m.dx = (1 - e) * W * 0.6; m.blur = (1 - p) * 30; break;
  }
  return m;
}

/** Quad placement for a source of size sw x sh on a W x H canvas under a clip's fit and transform. */
export function placeLayer(clip: Clip, tRel: number, sw: number, sh: number, W: number, H: number, fx: ResolvedEffects, tm: ReturnType<typeof transitionMods>): Omit<LayerDraw, 'source' | 'srcWidth' | 'srcHeight' | 'blend'> {
  const tf = clip.transform;
  const crop = tf.crop;
  const cw = sw * Math.max(0.001, 1 - crop.left - crop.right);
  const ch = sh * Math.max(0.001, 1 - crop.top - crop.bottom);
  const fit = clip.fit ?? 'cover';
  let bx: number, by: number;
  if (fit === 'stretch') { bx = W / cw; by = H / ch; }
  else { const s = fit === 'contain' ? Math.min(W / sw, H / sh) : Math.max(W / sw, H / sh); bx = s; by = s; }
  const k = evalAnim(tf.scale, tRel) * fx.zoom * tm.scale;
  const w = cw * bx * k;
  const h = ch * by * k;
  // Keep cropped content where it was: shift by half the asymmetric crop.
  const cx = W / 2 + evalAnim(tf.x, tRel) + ((crop.left - crop.right) / 2) * sw * bx * k + fx.shake.x + tm.dx;
  const cy = H / 2 + evalAnim(tf.y, tRel) + ((crop.top - crop.bottom) / 2) * sh * by * k + fx.shake.y + tm.dy;
  return {
    cx, cy, w, h,
    rotation: evalAnim(tf.rotation, tRel),
    opacity: evalAnim(tf.opacity, tRel) * tm.opacity,
    crop, flipH: tf.flipH, flipV: tf.flipV,
    color: fx.color, lut: fx.lut, lutStrength: fx.lutStrength, blur: fx.blur + tm.blur, key: fx.key, mask: fx.mask,
  };
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0');
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [number, number, number];
}

/** The same plan pointed at its matte video (read and cached under its own key). */
export function mattePlan(p: VisualPlan): VisualPlan | null {
  return p.matte ? { ...p, path: p.matte.path, clip: { ...p.clip, id: `${p.clip.id}#matte` }, matte: undefined } : null;
}

/** Plans plus their matte plans, for code that prefetches frames. */
export function withMattes(plans: VisualPlan[]): VisualPlan[] {
  return plans.flatMap((p) => { const m = mattePlan(p); return m ? [p, m] : [p]; });
}
