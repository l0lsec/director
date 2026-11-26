import {
  newProject, newClip, anim, uid, type Project, type Clip, type LaneKind, type MediaRef, type Op,
  splitOps, rippleDeleteRangeOps, trimOps, moveClipOps, deleteClipsOps, insertClipOps, setSpeedOps, slipOps,
  splitAllAtOps, duplicateClipOps, clipEnd, applyOps, LANE_ORDER,
} from '../src';

export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    bool: (p = 0.5) => next() < p,
  };
}
type R = ReturnType<typeof rng>;

const S = 1_000_000;

function randomAnim(r: R, base: number, spread: number) {
  const a = anim(base + (r.next() - 0.5) * spread);
  if (r.bool(0.3)) {
    const n = r.int(1, 4);
    const ts = [...new Set(Array.from({ length: n }, () => r.int(0, 3) * 250_000))].sort((x, y) => x - y);
    a.keyframes = ts.map((t) => ({ t, v: base + (r.next() - 0.5) * spread, ease: r.pick(['linear', 'ease', 'easeIn', 'easeOut', 'hold'] as const) }));
  }
  return a;
}

export function randomMedia(r: R): MediaRef {
  const kind = r.pick(['video', 'audio', 'image'] as const);
  return {
    id: uid('media'), path: `/tmp/fixture-${r.int(0, 999)}.${kind === 'audio' ? 'wav' : kind === 'image' ? 'png' : 'mp4'}`, hash: 'h' + r.int(0, 1e9),
    name: `media ${r.int(0, 99)}`, kind, durationUs: kind === 'image' ? 0 : r.int(2, 60) * S, hasAudio: kind !== 'image', hasVideo: kind !== 'audio',
    addedAt: '2026-11-24T00:00:00.000Z', ...(kind !== 'audio' ? { width: 1920, height: 1080, fps: { num: 30, den: 1 } } : { sampleRate: 48000, channels: 1 }),
  };
}

export function randomClip(r: R, doc: Project, start: number): Clip {
  const medias = Object.values(doc.media).filter((m) => m.kind !== 'image');
  const useMedia = medias.length > 0 && r.bool(0.7);
  if (useMedia) {
    const m = r.pick(medias);
    const inn = r.int(0, Math.max(0, m.durationUs / S - 2)) * S;
    const out = Math.min(m.durationUs, inn + r.int(1, 5) * S);
    return newClip({
      kind: 'media', mediaId: m.id, start, in: inn, out,
      transform: { x: randomAnim(r, 0, 200), y: randomAnim(r, 0, 200), scale: randomAnim(r, 1, 0.5), rotation: randomAnim(r, 0, 30), opacity: randomAnim(r, 1, 0.4), crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: r.bool(0.1), flipV: false },
      audio: { gainDb: randomAnim(r, 0, 6), pan: 0, fadeIn: r.bool(0.3) ? 200_000 : 0, fadeOut: r.bool(0.3) ? 200_000 : 0, muted: false, duckable: r.bool() },
      speed: r.bool(0.15) ? { kind: 'constant', rate: r.pick([0.5, 1.5, 2]), preservePitch: true } : { kind: 'constant', rate: 1, preservePitch: true },
      reverse: r.bool(0.08),
    });
  }
  const dur = r.int(1, 4) * S;
  const words = r.bool(0.5) ? [{ text: 'hello', start: 0, end: 300_000 }, { text: 'world', start: 400_000, end: Math.min(dur, 900_000) }] : undefined;
  return newClip({ kind: r.bool() ? 'text' : 'caption', start, in: 0, out: dur, text: { content: 'hello world', font: 'Inter', size: 64, weight: 800, color: '#fff', align: 'center', lineHeight: 1.1, maxWidth: 0.8, words } });
}

export function randomProject(seed: number): Project {
  const r = rng(seed);
  let doc = newProject({ name: `p${seed}`, id: `proj_${seed}`, now: '2026-11-24T00:00:00.000Z' });
  const ops: Op[] = [];
  for (let i = 0; i < r.int(0, 4); i++) ops.push({ op: 'addMedia', media: randomMedia(r) });
  doc = applyOps(doc, ops).doc;
  const more: Op[] = [];
  for (const lane of doc.lanes) {
    let t = 0;
    for (let i = 0; i < r.int(0, 4); i++) {
      t += r.int(0, 2) * 500_000;
      const c = randomClip(r, doc, t);
      more.push({ op: 'addClip', laneId: lane.id, clip: c });
      t = clipEnd(c);
    }
  }
  for (let i = 0; i < r.int(0, 3); i++) more.push({ op: 'addMarker', marker: { id: uid('mk'), t: r.int(0, 10) * S, kind: r.pick(['note', 'retake', 'cue'] as const), label: 'm' } });
  return applyOps(doc, more).doc;
}

/** A random but valid command against the current doc, compiled to primitive ops. */
export function randomCommand(r: R, doc: Project): { label: string; ops: Op[] } {
  const clips = doc.lanes.flatMap((l) => l.clips.map((c) => ({ lane: l, c })));
  const choice = r.int(0, 11);
  const any = clips.length ? r.pick(clips) : null;
  const S2 = 500_000;
  try {
    switch (choice) {
      case 0: if (any) { const at = any.c.start + Math.max(1, Math.floor((clipEnd(any.c) - any.c.start) * r.next())); return { label: 'split', ops: splitOps(doc, [any.c.id], at) }; } break;
      case 1: { const from = r.int(0, 10) * S2; return { label: 'ripple', ops: rippleDeleteRangeOps(doc, from, from + r.int(1, 4) * S2) }; }
      case 2: if (any) return { label: 'trimEnd', ops: trimOps(doc, any.c.id, 'end', any.c.start + r.int(1, 6) * S2, { ripple: r.bool() }) }; break;
      case 3: if (any) return { label: 'trimStart', ops: trimOps(doc, any.c.id, 'start', Math.max(0, any.c.start + r.int(-2, 3) * S2), { ripple: r.bool() }) }; break;
      case 4: if (any) { const target = r.pick(doc.lanes); return { label: 'move', ops: moveClipOps(doc, any.c.id, target.id, r.int(0, 12) * S2) }; } break;
      case 5: if (any) return { label: 'delete', ops: deleteClipsOps(doc, [any.c.id], r.bool()) }; break;
      case 6: { const lane = r.pick(doc.lanes); return { label: 'insert', ops: insertClipOps(doc, lane.id, randomClip(r, doc, r.int(0, 10) * S2), r.bool()) }; }
      case 7: if (any) return { label: 'speed', ops: setSpeedOps(doc, any.c.id, r.pick([0.5, 1, 2, 3]), r.bool()) }; break;
      case 8: if (any) return { label: 'slip', ops: slipOps(doc, any.c.id, r.int(-3, 3) * S2) }; break;
      case 9: return { label: 'bladeAll', ops: splitAllAtOps(doc, r.int(1, 20) * S2) };
      case 10: if (any) return { label: 'dup', ops: duplicateClipOps(doc, any.c.id) }; break;
      case 11: return { label: 'meta', ops: [{ op: 'setMeta', patch: { name: `renamed ${r.int(0, 99)}` } }, { op: 'setCanvas', patch: { width: r.pick([1080, 1920]) } }] };
    }
  } catch {
    return { label: 'noop', ops: [] };
  }
  return { label: 'noop', ops: [] };
}

export const ALL_LANES: LaneKind[] = LANE_ORDER;
