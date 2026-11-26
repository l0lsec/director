import { describe, expect, it } from 'vitest';
import {
  newProject, newClip, applyOps, splitOps, rippleDeleteRangeOps, rippleDeleteRangesOps, trimOps, moveClipOps, deleteClipsOps,
  clipEnd, clipDuration, sourceTimeAt, evalAnim, laneOfKind, insertClipOps, snapTime, mergeRanges, type Project, type Op, uid,
} from '../src';

const S = 1_000_000;
function setup(): { doc: Project; cam: string; voice: string } {
  let doc = newProject({ name: 't' });
  const cam = laneOfKind(doc, 'camera')!.id;
  const voice = laneOfKind(doc, 'voice')!.id;
  const ops: Op[] = [
    { op: 'addMedia', media: { id: 'm1', path: '/x.mp4', hash: '', name: 'x', kind: 'video', durationUs: 20 * S, hasAudio: true, hasVideo: true, addedAt: '' } },
  ];
  doc = applyOps(doc, ops).doc;
  doc = applyOps(doc, [
    { op: 'addClip', laneId: cam, clip: newClip({ id: 'a', kind: 'media', mediaId: 'm1', start: 0, in: 0, out: 4 * S, linkGroup: 'g1' }) },
    { op: 'addClip', laneId: voice, clip: newClip({ id: 'av', kind: 'media', mediaId: 'm1', start: 0, in: 0, out: 4 * S, linkGroup: 'g1' }) },
    { op: 'addClip', laneId: cam, clip: newClip({ id: 'b', kind: 'media', mediaId: 'm1', start: 4 * S, in: 10 * S, out: 14 * S }) },
  ]).doc;
  return { doc, cam, voice };
}
const lane = (doc: Project, id: string) => doc.lanes.find((l) => l.id === id)!;

describe('commands', () => {
  it('split divides source range and keeps links paired', () => {
    const { doc, cam, voice } = setup();
    const next = applyOps(doc, splitOps(doc, ['a'], 1.5 * S)).doc;
    const c = lane(next, cam).clips;
    expect(c.map((x) => [x.start, x.in, x.out])).toEqual([[0, 0, 1.5 * S], [1.5 * S, 1.5 * S, 4 * S], [4 * S, 10 * S, 14 * S]]);
    const v = lane(next, voice).clips;
    expect(v).toHaveLength(2);
    expect(v[1]!.linkGroup).toBe(c[1]!.linkGroup);
    expect(v[1]!.linkGroup).not.toBe('g1');
  });

  it('ripple delete range cuts across lanes and closes the gap', () => {
    const { doc, cam, voice } = setup();
    const next = applyOps(doc, rippleDeleteRangeOps(doc, 1 * S, 2 * S)).doc;
    const c = lane(next, cam).clips;
    expect(c.map((x) => [x.start, clipEnd(x), x.in, x.out])).toEqual([[0, S, 0, S], [S, 3 * S, 2 * S, 4 * S], [3 * S, 7 * S, 10 * S, 14 * S]]);
    expect(lane(next, voice).clips.map((x) => [x.start, clipEnd(x)])).toEqual([[0, S], [S, 3 * S]]);
  });

  it('many ripple ranges apply from the end and merge overlaps', () => {
    const { doc, cam } = setup();
    expect(mergeRanges([{ from: 5, to: 9 }, { from: 1, to: 3 }, { from: 2, to: 4 }])).toEqual([{ from: 1, to: 4 }, { from: 5, to: 9 }]);
    const next = applyOps(doc, rippleDeleteRangesOps(doc, [{ from: 0.5 * S, to: S }, { from: 5 * S, to: 6 * S }])).doc;
    const total = lane(next, cam).clips.reduce((n, c) => n + clipDuration(c), 0);
    expect(total).toBe(8 * S - 1.5 * S);
  });

  it('trim end respects media length; trim start shifts keyframes', () => {
    const { doc } = setup();
    let next = applyOps(doc, trimOps(doc, 'b', 'end', 30 * S)).doc;
    const b = next.lanes.flatMap((l) => l.clips).find((c) => c.id === 'b')!;
    expect(b.out).toBe(20 * S);
    const withKf = applyOps(doc, [{ op: 'updateClip', id: 'b', patch: { transform: { ...b.transform, scale: { value: 1, keyframes: [{ t: 0, v: 1, ease: 'linear' }, { t: 2 * S, v: 2, ease: 'linear' }] } } } }]).doc;
    next = applyOps(withKf, trimOps(withKf, 'b', 'start', 5 * S)).doc;
    const b2 = next.lanes.flatMap((l) => l.clips).find((c) => c.id === 'b')!;
    expect(b2.start).toBe(5 * S);
    expect(b2.in).toBe(11 * S);
    expect(evalAnim(b2.transform.scale, 0)).toBeCloseTo(1.5, 6);
    expect(evalAnim(b2.transform.scale, S)).toBeCloseTo(2, 6);
  });

  it('move overwrites the destination and carries linked clips', () => {
    const { doc, cam, voice } = setup();
    const next = applyOps(doc, moveClipOps(doc, 'a', cam, 6 * S)).doc;
    expect(lane(next, cam).clips.map((c) => [c.id, c.start, clipEnd(c)])).toEqual([['b', 4 * S, 6 * S], ['a', 6 * S, 10 * S]]);
    expect(lane(next, voice).clips[0]!.start).toBe(6 * S);
  });

  it('ripple delete of a clip pulls later clips left', () => {
    const { doc, cam } = setup();
    const next = applyOps(doc, deleteClipsOps(doc, ['a'], true)).doc;
    expect(lane(next, cam).clips.map((c) => [c.id, c.start])).toEqual([['b', 0]]);
  });

  it('insert with ripple pushes everything right', () => {
    const { doc, cam, voice } = setup();
    const ins = newClip({ id: uid('c'), kind: 'text', start: 2 * S, out: S });
    const next = applyOps(doc, insertClipOps(doc, laneOfKind(doc, 'titles')!.id, ins, true)).doc;
    expect(lane(next, cam).clips.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 2 * S], [3 * S, 5 * S], [5 * S, 9 * S]]);
    expect(lane(next, voice).clips.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 2 * S], [3 * S, 5 * S]]);
  });

  it('speed, reverse and ramps map timeline to source time', () => {
    const c = newClip({ kind: 'media', start: S, in: 2 * S, out: 6 * S, speed: { kind: 'constant', rate: 2, preservePitch: true } });
    expect(clipDuration(c)).toBe(2 * S);
    expect(sourceTimeAt(c, 2 * S)).toBe(4 * S);
    expect(sourceTimeAt({ ...c, reverse: true }, 2 * S)).toBe(4 * S);
    expect(sourceTimeAt({ ...c, reverse: true }, S)).toBe(6 * S);
    const ramp = { ...c, speed: { kind: 'ramp' as const, points: [{ at: 0, rate: 1 }, { at: 1, rate: 3 }], preservePitch: true } };
    expect(clipDuration(ramp)).toBe(2 * S);
    expect(sourceTimeAt(ramp, S + clipDuration(ramp))).toBe(6 * S);
  });

  it('snaps to nearby edges', () => {
    const { doc } = setup();
    expect(snapTime(doc, 4 * S + 30_000, 50_000)).toEqual({ t: 4 * S, snapped: true });
    expect(snapTime(doc, 5 * S, 50_000).snapped).toBe(false);
  });
});
