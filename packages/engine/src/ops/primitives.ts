import { current, isDraft, produce, setAutoFreeze } from 'immer';
import { z } from 'zod';
import {
  CanvasSchema, ClipSchema, LaneSchema, MarkerSchema, MediaRefSchema, ProjectSchema,
  type Clip, type Lane, type Project,
} from '../schema/project';

setAutoFreeze(false);

/** Deep plain copy that works on Immer drafts and plain values alike. */
function snap<T>(x: T): T {
  return isDraft(x) ? (current(x as never) as T) : structuredClone(x);
}

const Id = z.string().min(1).max(64);
const Keys = z.array(z.string().max(64)).max(64).optional();

const ClipPatch = ClipSchema.omit({ id: true }).partial();
const LanePatch = LaneSchema.omit({ id: true, clips: true }).partial();
const MediaPatch = MediaRefSchema.omit({ id: true }).partial();
const MarkerPatch = MarkerSchema.omit({ id: true }).partial();
const MetaPatch = ProjectSchema.pick({ name: true, brandId: true, scriptRef: true, scriptText: true, settings: true, transcript: true }).partial();

/** Primitive, invertible, serializable edit operations. Everything that changes a project is one of these. */
export const OpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addMedia'), media: MediaRefSchema }),
  z.object({ op: z.literal('removeMedia'), id: Id }),
  z.object({ op: z.literal('updateMedia'), id: Id, patch: MediaPatch, unset: Keys }),
  z.object({ op: z.literal('addLane'), lane: LaneSchema, index: z.number().int().nonnegative() }),
  z.object({ op: z.literal('removeLane'), id: Id }),
  z.object({ op: z.literal('updateLane'), id: Id, patch: LanePatch, unset: Keys }),
  z.object({ op: z.literal('moveLane'), id: Id, index: z.number().int().nonnegative() }),
  z.object({ op: z.literal('addClip'), laneId: Id, clip: ClipSchema }),
  z.object({ op: z.literal('removeClip'), id: Id }),
  z.object({ op: z.literal('updateClip'), id: Id, patch: ClipPatch, unset: Keys }),
  z.object({ op: z.literal('moveClipToLane'), id: Id, laneId: Id }),
  z.object({ op: z.literal('addMarker'), marker: MarkerSchema }),
  z.object({ op: z.literal('removeMarker'), id: Id }),
  z.object({ op: z.literal('updateMarker'), id: Id, patch: MarkerPatch, unset: Keys }),
  z.object({ op: z.literal('setCanvas'), patch: CanvasSchema.partial() }),
  z.object({ op: z.literal('setMeta'), patch: MetaPatch, unset: Keys }),
]);
export type Op = z.infer<typeof OpSchema>;

export class OpError extends Error {
  public code: string;
  constructor(message: string, code = 'OP_INVALID') { super(message); this.code = code; }
}

function sortClips(lane: Lane): void {
  lane.clips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Records original values of patched keys so the update can be inverted exactly. */
function invertPatch<T extends object>(target: T, patch: object, unset: string[] | undefined): { patch: Record<string, unknown>; unset: string[] } {
  const back: Record<string, unknown> = {};
  const backUnset: string[] = [];
  const keys = [...Object.keys(patch), ...(unset ?? [])];
  for (const k of keys) {
    const cur = (target as Record<string, unknown>)[k];
    if (cur === undefined) backUnset.push(k);
    else back[k] = snap(cur);
  }
  return { patch: back, unset: backUnset };
}

function applyPatch(target: Record<string, unknown>, patch: object, unset: string[] | undefined): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete target[k];
    else target[k] = structuredClone(v);
  }
  for (const k of unset ?? []) delete target[k];
}

function locateClip(doc: Project, id: string): { lane: Lane; index: number; clip: Clip } {
  for (const lane of doc.lanes) {
    const index = lane.clips.findIndex((c) => c.id === id);
    if (index >= 0) return { lane, index, clip: lane.clips[index]! };
  }
  throw new OpError(`clip ${id} not found`, 'NOT_FOUND');
}

function laneById(doc: Project, id: string): Lane {
  const lane = doc.lanes.find((l) => l.id === id);
  if (!lane) throw new OpError(`lane ${id} not found`, 'NOT_FOUND');
  return lane;
}

function assertNewClipId(doc: Project, id: string): void {
  for (const l of doc.lanes) if (l.clips.some((c) => c.id === id)) throw new OpError(`clip id ${id} already exists`, 'DUPLICATE');
}

/** Apply one primitive op. Returns the new document (input is not mutated) and the exact inverse op. */
export function applyOp(doc: Project, op: Op): { doc: Project; inverse: Op } {
  let inverse!: Op;
  const next = produce(doc, (d) => {
    switch (op.op) {
      case 'addMedia': {
        if (d.media[op.media.id]) throw new OpError(`media ${op.media.id} already exists`, 'DUPLICATE');
        d.media[op.media.id] = structuredClone(op.media);
        inverse = { op: 'removeMedia', id: op.media.id };
        break;
      }
      case 'removeMedia': {
        const m = d.media[op.id];
        if (!m) throw new OpError(`media ${op.id} not found`, 'NOT_FOUND');
        for (const l of d.lanes) if (l.clips.some((c) => c.mediaId === op.id)) throw new OpError(`media ${op.id} is still used on the timeline`, 'IN_USE');
        inverse = { op: 'addMedia', media: snap(m) };
        delete d.media[op.id];
        break;
      }
      case 'updateMedia': {
        const m = d.media[op.id];
        if (!m) throw new OpError(`media ${op.id} not found`, 'NOT_FOUND');
        const inv = invertPatch(m, op.patch, op.unset);
        applyPatch(m as Record<string, unknown>, op.patch, op.unset);
        inverse = { op: 'updateMedia', id: op.id, patch: inv.patch, unset: inv.unset };
        break;
      }
      case 'addLane': {
        if (d.lanes.some((l) => l.id === op.lane.id)) throw new OpError(`lane ${op.lane.id} already exists`, 'DUPLICATE');
        for (const c of op.lane.clips) assertNewClipId(d as Project, c.id);
        const idx = Math.min(op.index, d.lanes.length);
        const lane = structuredClone(op.lane);
        sortClips(lane);
        d.lanes.splice(idx, 0, lane);
        inverse = { op: 'removeLane', id: op.lane.id };
        break;
      }
      case 'removeLane': {
        const idx = d.lanes.findIndex((l) => l.id === op.id);
        if (idx < 0) throw new OpError(`lane ${op.id} not found`, 'NOT_FOUND');
        inverse = { op: 'addLane', lane: snap(d.lanes[idx]!) as Lane, index: idx };
        d.lanes.splice(idx, 1);
        break;
      }
      case 'updateLane': {
        const lane = laneById(d as Project, op.id);
        const inv = invertPatch(lane, op.patch, op.unset);
        applyPatch(lane as unknown as Record<string, unknown>, op.patch, op.unset);
        inverse = { op: 'updateLane', id: op.id, patch: inv.patch, unset: inv.unset };
        break;
      }
      case 'moveLane': {
        const idx = d.lanes.findIndex((l) => l.id === op.id);
        if (idx < 0) throw new OpError(`lane ${op.id} not found`, 'NOT_FOUND');
        const [lane] = d.lanes.splice(idx, 1);
        d.lanes.splice(Math.min(op.index, d.lanes.length), 0, lane!);
        inverse = { op: 'moveLane', id: op.id, index: idx };
        break;
      }
      case 'addClip': {
        const lane = laneById(d as Project, op.laneId);
        assertNewClipId(d as Project, op.clip.id);
        if (op.clip.mediaId && !d.media[op.clip.mediaId]) throw new OpError(`clip references missing media ${op.clip.mediaId}`, 'NOT_FOUND');
        if (op.clip.out <= op.clip.in) throw new OpError('clip out must be after in', 'RANGE');
        lane.clips.push(structuredClone(op.clip));
        sortClips(lane);
        inverse = { op: 'removeClip', id: op.clip.id };
        break;
      }
      case 'removeClip': {
        const { lane, index, clip } = locateClip(d as Project, op.id);
        inverse = { op: 'addClip', laneId: lane.id, clip: snap(clip) as Clip };
        lane.clips.splice(index, 1);
        break;
      }
      case 'updateClip': {
        const { lane, clip } = locateClip(d as Project, op.id);
        const inv = invertPatch(clip, op.patch, op.unset);
        applyPatch(clip as unknown as Record<string, unknown>, op.patch, op.unset);
        if (clip.out <= clip.in) throw new OpError('clip out must be after in', 'RANGE');
        if (clip.start < 0) throw new OpError('clip start must be >= 0', 'RANGE');
        if (clip.mediaId && !d.media[clip.mediaId]) throw new OpError(`clip references missing media ${clip.mediaId}`, 'NOT_FOUND');
        sortClips(lane);
        inverse = { op: 'updateClip', id: op.id, patch: inv.patch, unset: inv.unset };
        break;
      }
      case 'moveClipToLane': {
        const { lane, index, clip } = locateClip(d as Project, op.id);
        const target = laneById(d as Project, op.laneId);
        lane.clips.splice(index, 1);
        target.clips.push(clip);
        sortClips(target);
        inverse = { op: 'moveClipToLane', id: op.id, laneId: lane.id };
        break;
      }
      case 'addMarker': {
        if (d.markers.some((m) => m.id === op.marker.id)) throw new OpError(`marker ${op.marker.id} already exists`, 'DUPLICATE');
        d.markers.push(structuredClone(op.marker));
        d.markers.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
        inverse = { op: 'removeMarker', id: op.marker.id };
        break;
      }
      case 'removeMarker': {
        const idx = d.markers.findIndex((m) => m.id === op.id);
        if (idx < 0) throw new OpError(`marker ${op.id} not found`, 'NOT_FOUND');
        inverse = { op: 'addMarker', marker: snap(d.markers[idx]!) };
        d.markers.splice(idx, 1);
        break;
      }
      case 'updateMarker': {
        const m = d.markers.find((x) => x.id === op.id);
        if (!m) throw new OpError(`marker ${op.id} not found`, 'NOT_FOUND');
        const inv = invertPatch(m, op.patch, op.unset);
        applyPatch(m as Record<string, unknown>, op.patch, op.unset);
        d.markers.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
        inverse = { op: 'updateMarker', id: op.id, patch: inv.patch, unset: inv.unset };
        break;
      }
      case 'setCanvas': {
        const inv = invertPatch(d.canvas, op.patch, undefined);
        applyPatch(d.canvas as Record<string, unknown>, op.patch, undefined);
        inverse = { op: 'setCanvas', patch: inv.patch };
        break;
      }
      case 'setMeta': {
        const inv = invertPatch(d, op.patch, op.unset);
        applyPatch(d as unknown as Record<string, unknown>, op.patch, op.unset);
        inverse = { op: 'setMeta', patch: inv.patch, unset: inv.unset };
        break;
      }
      default: {
        const never: never = op;
        throw new OpError(`unknown op ${(never as { op: string }).op}`);
      }
    }
  });
  return { doc: next, inverse };
}

/** Apply ops in order. All-or-nothing: on error, the original document is untouched. */
export function applyOps(doc: Project, ops: Op[]): { doc: Project; inverses: Op[] } {
  let cur = doc;
  const inverses: Op[] = [];
  for (const op of ops) {
    const r = applyOp(cur, op);
    cur = r.doc;
    inverses.push(r.inverse);
  }
  return { doc: cur, inverses: inverses.reverse() };
}

/** Validate untrusted ops (from AI, MCP, journal) before applying them. */
export function parseOps(raw: unknown): { ok: true; ops: Op[] } | { ok: false; errors: string[] } {
  const res = z.array(OpSchema).max(5000).safeParse(raw);
  if (!res.success) return { ok: false, errors: res.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`) };
  return { ok: true, ops: res.data };
}
