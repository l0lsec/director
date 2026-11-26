import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScdet, detectCuts, scoreCuts, shotsFromCuts, scdetArgs, computePacing, comparePacing, editShots } from '../src';
import { newProject, newClip, applyOps, uid, type Op } from '@director/engine';

const root = join(__dirname, '..', '..', '..');
const gt = JSON.parse(readFileSync(join(root, 'fixtures', 'ground-truth.json'), 'utf8'));
const scores = (name: string) => parseScdet(execFileSync('ffmpeg', scdetArgs(join(root, 'fixtures', 'media', name)), { encoding: 'utf8', maxBuffer: 64 << 20 }));

describe('shot detection', () => {
  for (const name of ['cuts-720p.mp4', 'reference-reel.mp4']) {
    it(`finds every hard cut in ${name} within one frame`, () => {
      const truth = gt.files[name];
      const fps = truth.fps[0] / truth.fps[1];
      const s = scores(name);
      expect(s.length).toBe(truth.frames);
      const cuts = detectCuts(s);
      const r = scoreCuts(cuts.map((t) => Math.round(t * fps)), truth.cutsAtFrames, 1);
      expect(r.precision).toBeGreaterThanOrEqual(0.95);
      expect(r.recall).toBeGreaterThanOrEqual(0.95);
      expect(r.maxError).toBeLessThanOrEqual(1);
    });
  }
  it('ignores motion and isolated flashes in synthetic scores', () => {
    const s = Array.from({ length: 300 }, (_, i) => ({ t: i / 30, score: 3 + 2 * Math.sin(i / 3) }));
    s[100]!.score = 40; s[101]!.score = 38; // a two-frame flash keeps only the peak
    s[200]!.score = 9; // barely over the floor but inside heavy motion
    for (let i = 190; i < 210; i++) if (i !== 200) s[i]!.score = 8;
    expect(detectCuts(s).map((t) => Math.round(t * 30))).toEqual([100]);
  });
  it('scoreCuts counts misses and false alarms', () => {
    expect(scoreCuts([10, 50, 90], [10, 51, 200])).toMatchObject({ precision: 2 / 3, recall: 2 / 3, maxError: 1 });
    expect(shotsFromCuts([1, 2], 3)).toEqual([{ start: 0, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }]);
  });
});

describe('pacing', () => {
  it('matches values computed by hand', () => {
    const shots = shotsFromCuts([2, 4.5, 10], 12);
    const words = [{ start: 0, end: 0.5 }, { start: 1, end: 1.5 }, { start: 3, end: 4 }];
    const p = computePacing(shots, 12, words);
    expect(p).toMatchObject({ shotCount: 4, firstCutSec: 2, wordCount: 3 });
    expect(p.avgShotSec).toBeCloseTo(3, 10);
    expect(p.medianShotSec).toBeCloseTo(2.25, 10);
    expect(p.longestShotSec).toBeCloseTo(5.5, 10);
    expect(p.cutsPerMin).toBeCloseTo(15, 10);
    expect(p.wordsPerSec).toBeCloseTo(0.25, 10);
    expect(p.speechRatio).toBeCloseTo(2 / 12, 10);
  });
  it('derives edit shots from clip boundaries and zooms, and compares', () => {
    let doc = newProject({ name: 't', canvas: { width: 1080, height: 1920 } });
    const cam = doc.lanes.find((l) => l.kind === 'camera')!;
    const broll = doc.lanes.find((l) => l.kind === 'broll')!;
    const ops: Op[] = [
      { op: 'addClip', laneId: cam.id, clip: newClip({ kind: 'media', start: 0, out: 6_000_000, effects: [{ id: uid('fx'), type: 'zoom', enabled: true, params: { at: 2_000_000, amount: 1.2 } }] }) },
      { op: 'addClip', laneId: cam.id, clip: newClip({ kind: 'media', start: 6_000_000, out: 6_000_000 }) },
      { op: 'addClip', laneId: broll.id, clip: newClip({ kind: 'placeholder', start: 8_000_000, out: 1_000_000 }) },
    ];
    doc = applyOps(doc, ops).doc;
    expect(editShots(doc).map((s) => s.start)).toEqual([0, 2, 6, 8, 9]);
    const mine = computePacing(editShots(doc), 12, []);
    const ref = computePacing(shotsFromCuts([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12), 12, []);
    const d = comparePacing(mine, ref);
    const avg = d.find((x) => x.metric === 'avgShotSec')!;
    expect(avg.yours).toBeCloseTo(2.4, 10);
    expect(avg.reference).toBeCloseTo(1, 10);
    expect(avg.pct).toBeCloseTo(140, 10);
    expect(avg.note).toMatch(/140% longer/);
    expect(d.find((x) => x.metric === 'cutsPerMin')!.note).toMatch(/64% less often/);
  });
});
