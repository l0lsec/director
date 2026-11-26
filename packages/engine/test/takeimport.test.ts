import { describe, expect, it } from 'vitest';
import { newProject, takeToOps, applyOps, clipEnd, laneOfKind, TakeSchema, type MediaRef, type Take } from '../src';

const take: Take = TakeSchema.parse({
  schemaVersion: 1, id: 'take_abc', title: 'Hook test', createdAt: '2026-11-24T00:00:00Z', durationUs: 10_000_000,
  files: { camera: 'camera.mp4', screen: 'screen.mov' }, devices: {}, clock: { cameraStartMs: 1000, screenStartMs: 950, screenOffsetUs: -50_000 },
  script: { text: 'Hello there' }, markers: [{ t: 2_000_000, kind: 'retake', label: 'Retake line 1', line: 0, wordIndex: 0 }, { t: 3_000_000, kind: 'cue', label: 'ZOOM', wordIndex: 4 }],
  alignment: [], recorder: { mimeType: 'video/mp4', videoBitsPerSecond: 1, chunks: 1 }, rating: 0, notes: '', status: 'ok',
});
const media = (id: string, role: MediaRef['role'], dur: number, audio: boolean): MediaRef => ({ id, path: `/t/${id}`, hash: '', name: id, kind: 'video', durationUs: dur, hasAudio: audio, hasVideo: true, addedAt: '', role });

describe('take to timeline', () => {
  it('places camera, linked voice and offset screen in sync with markers', () => {
    const doc = newProject({ name: 't' });
    const next = applyOps(doc, takeToOps(doc, take, { camera: media('cam', 'camera', 10_000_000, true), screen: media('scr', 'screen', 10_100_000, false) })).doc;
    const cam = laneOfKind(next, 'camera')!.clips[0]!;
    const voice = laneOfKind(next, 'voice')!.clips[0]!;
    const scr = laneOfKind(next, 'screen')!.clips[0]!;
    // Screen started 50 ms before the camera, so the camera moves right by 50 ms and the screen sits at 0.
    expect(scr.start).toBe(0);
    expect(cam.start).toBe(50_000);
    expect(voice.start).toBe(cam.start);
    expect(clipEnd(voice)).toBe(clipEnd(cam));
    expect(cam.audio!.muted).toBe(true);
    expect(voice.audio!.muted).toBe(false);
    expect(new Set([cam.linkGroup, voice.linkGroup, scr.linkGroup]).size).toBe(1);
    expect(next.markers.map((m) => [m.kind, m.t])).toEqual([['retake', 2_050_000], ['cue', 3_050_000]]);
    expect(next.scriptText).toBe('Hello there');
  });

  it('applies the audio sync calibration to the voice clip only', () => {
    const doc = newProject({ name: 't' });
    const late = { ...take, files: { camera: 'camera.mp4' }, clock: { cameraStartMs: 1000, audioOffsetUs: 40_000 } };
    const next = applyOps(doc, takeToOps(doc, late, { camera: media('cam', 'camera', 10_000_000, true) })).doc;
    const cam = laneOfKind(next, 'camera')!.clips[0]!;
    const voice = laneOfKind(next, 'voice')!.clips[0]!;
    expect(voice.start).toBe(cam.start);
    expect(voice.in).toBe(40_000);
  });

  it('appends later takes after existing content', () => {
    let doc = newProject({ name: 't' });
    const t2 = { ...take, files: { camera: 'camera.mp4' }, clock: { cameraStartMs: 1 } };
    doc = applyOps(doc, takeToOps(doc, t2, { camera: media('a', 'camera', 4_000_000, true) })).doc;
    doc = applyOps(doc, takeToOps(doc, t2, { camera: media('b', 'camera', 3_000_000, true) })).doc;
    expect(laneOfKind(doc, 'camera')!.clips.map((c) => c.start)).toEqual([0, 4_000_000]);
  });
});
