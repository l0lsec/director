import type { Animatable, Canvas, Clip, ClipAudio, Lane, LaneKind, Project, Speed, Transform, TextSpec } from '../schema/project';
import { CURRENT_SCHEMA_VERSION, LANE_LABEL, LANE_ORDER } from '../schema/project';
import type { Micros } from '../time';

export function uid(prefix = 'id'): string {
  const c = globalThis.crypto;
  const raw = c && 'randomUUID' in c ? c.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2) + Date.now().toString(16);
  return `${prefix}_${raw.slice(0, 16)}`;
}

export const anim = (value: number): Animatable => ({ value });

export function defaultTransform(): Transform {
  return { x: anim(0), y: anim(0), scale: anim(1), rotation: anim(0), opacity: anim(1), crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false };
}

export function defaultAudio(): ClipAudio {
  return { gainDb: anim(0), pan: 0, fadeIn: 0, fadeOut: 0, muted: false, duckable: false };
}

export const constantSpeed = (rate = 1): Speed => ({ kind: 'constant', rate, preservePitch: true });

export function newClip(init: Partial<Clip> & Pick<Clip, 'kind' | 'start' | 'out'>): Clip {
  return {
    id: init.id ?? uid('clip'),
    in: 0,
    speed: constantSpeed(),
    reverse: false,
    transform: defaultTransform(),
    blend: 'normal',
    effects: [],
    enabled: true,
    ...init,
  };
}

export function defaultText(content: string, overrides: Partial<TextSpec> = {}): TextSpec {
  return { content, font: 'Inter', size: 72, weight: 800, color: '#ffffff', align: 'center', lineHeight: 1.1, maxWidth: 0.86, ...overrides };
}

export function newLane(kind: LaneKind, init: Partial<Lane> = {}): Lane {
  return { id: init.id ?? uid('lane'), kind, name: init.name ?? LANE_LABEL[kind], muted: false, hidden: false, locked: false, solo: false, clips: [], ...init };
}

export const CANVAS_PRESETS: Record<string, Pick<Canvas, 'width' | 'height'>> = {
  'vertical-1080': { width: 1080, height: 1920 },
  'landscape-1080': { width: 1920, height: 1080 },
  'landscape-4k': { width: 3840, height: 2160 },
  'square-1080': { width: 1080, height: 1080 },
  'portrait-4x5': { width: 1080, height: 1350 },
};

export function newProject(init: { name: string; id?: string; canvas?: Partial<Canvas>; lanes?: LaneKind[]; now?: string }): Project {
  const now = init.now ?? new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: init.id ?? uid('proj'),
    name: init.name,
    createdAt: now,
    updatedAt: now,
    canvas: { width: 1080, height: 1920, fps: { num: 30, den: 1 }, background: { kind: 'color', color: '#000000' }, sampleRate: 48000, ...init.canvas },
    media: {},
    lanes: (init.lanes ?? LANE_ORDER).map((k) => newLane(k)),
    markers: [],
    settings: { snapping: true, rippleByDefault: true, safeZone: 'reels' },
  };
}

/** Integral of a piecewise-linear rate curve over normalized output time [0, x]. */
export function rampIntegral(points: Array<{ at: number; rate: number }>, x: number): number {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (x <= a.at) break;
    const hi = Math.min(x, b.at);
    const span = b.at - a.at;
    if (span <= 0) continue;
    const rateAt = (u: number) => a.rate + ((b.rate - a.rate) * (u - a.at)) / span;
    acc += ((rateAt(a.at) + rateAt(hi)) / 2) * (hi - a.at);
  }
  return acc;
}

/** Timeline duration of a clip. */
export function clipDuration(c: Pick<Clip, 'in' | 'out' | 'speed' | 'freezeAt'>): Micros {
  const src = c.out - c.in;
  if (c.freezeAt != null) return src;
  if (c.speed.kind === 'constant') return Math.max(1, Math.round(src / c.speed.rate));
  const avg = rampIntegral(c.speed.points, 1);
  return Math.max(1, Math.round(src / avg));
}

export const clipEnd = (c: Clip): Micros => c.start + clipDuration(c);

/** Map a timeline time to a source time for a media clip. */
export function sourceTimeAt(c: Clip, t: Micros): Micros {
  if (c.freezeAt != null) return c.freezeAt;
  const d = clipDuration(c);
  const rel = Math.min(Math.max(t - c.start, 0), d);
  const span = c.out - c.in;
  let offset: number;
  if (c.speed.kind === 'constant') offset = rel * c.speed.rate;
  else offset = span * (rampIntegral(c.speed.points, rel / d) / rampIntegral(c.speed.points, 1));
  offset = Math.min(Math.max(offset, 0), span);
  return Math.round(c.reverse ? c.out - offset : c.in + offset);
}

export interface ClipLocation { lane: Lane; laneIndex: number; clip: Clip; index: number }

export function findClip(doc: Project, id: string): ClipLocation | null {
  for (let li = 0; li < doc.lanes.length; li++) {
    const lane = doc.lanes[li]!;
    const index = lane.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { lane, laneIndex: li, clip: lane.clips[index]!, index };
  }
  return null;
}

export function findLane(doc: Project, id: string): Lane | undefined {
  return doc.lanes.find((l) => l.id === id);
}

export function laneOfKind(doc: Project, kind: LaneKind): Lane | undefined {
  return doc.lanes.find((l) => l.kind === kind);
}

export function timelineDuration(doc: Project): Micros {
  let end = 0;
  for (const lane of doc.lanes) for (const c of lane.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export function allClips(doc: Project): Clip[] {
  return doc.lanes.flatMap((l) => l.clips);
}

export function clipsAt(doc: Project, t: Micros): Array<{ lane: Lane; clip: Clip }> {
  const out: Array<{ lane: Lane; clip: Clip }> = [];
  for (const lane of doc.lanes) for (const clip of lane.clips) if (clip.start <= t && t < clipEnd(clip)) out.push({ lane, clip });
  return out;
}

const EASE: Record<string, (x: number) => number> = {
  linear: (x) => x,
  ease: (x) => x * x * (3 - 2 * x),
  easeIn: (x) => x * x * x,
  easeOut: (x) => 1 - Math.pow(1 - x, 3),
  hold: () => 0,
};

/** Evaluate an animatable at a time relative to the clip start. The ease is the one on the segment's starting keyframe. */
export function evalAnim(a: Animatable, tRel: Micros): number {
  const kfs = a.keyframes;
  if (!kfs || kfs.length === 0) return a.value;
  if (tRel <= kfs[0]!.t) return kfs[0]!.v;
  const last = kfs[kfs.length - 1]!;
  if (tRel >= last.t) return last.v;
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i]!;
    const k1 = kfs[i + 1]!;
    if (tRel >= k0.t && tRel < k1.t) {
      const x = (tRel - k0.t) / (k1.t - k0.t);
      const e = (EASE[k0.ease] ?? EASE.linear!)(x);
      return k0.v + (k1.v - k0.v) * e;
    }
  }
  return last.v;
}

/** Set or replace a keyframe at tRel (sorted, unique times). */
export function withKeyframe(a: Animatable, tRel: Micros, v: number, ease: 'linear' | 'ease' | 'easeIn' | 'easeOut' | 'hold' = 'linear'): Animatable {
  const kfs = (a.keyframes ?? []).filter((k) => k.t !== tRel);
  kfs.push({ t: tRel, v, ease });
  kfs.sort((x, y) => x.t - y.t);
  return { value: a.value, keyframes: kfs };
}

export function dbToGain(db: number): number { return Math.pow(10, db / 20); }
export function gainToDb(g: number): number { return 20 * Math.log10(Math.max(g, 1e-9)); }
