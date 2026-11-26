import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeMedia } from '../../src/main/jobs/probe';

const root = join(__dirname, '../../../..');
const gt = JSON.parse(readFileSync(join(root, 'fixtures/ground-truth.json'), 'utf8'));
const media = (n: string) => join(root, 'fixtures/media', n);

describe('ffprobe wrapper', () => {
  it('returns typed metadata for every fixture with duration within one frame', async () => {
    let checked = 0;
    for (const name of Object.keys(gt.checksums)) {
      const p = await probeMedia(media(name));
      const truth = gt.files[name];
      checked++;
      if (name.endsWith('.png')) { expect(p.kind).toBe('image'); expect(p.video!.width).toBe(truth.width); continue; }
      const expectedSec = truth?.durationSec ?? (name === 'speech.wav' ? gt.speech.durationSec : name === 'speech-gaps.wav' ? gt.speechGaps.durationSec : name === 'retakes.wav' ? gt.retakes.durationSec : null);
      if (expectedSec != null) expect(Math.abs(p.durationUs / 1e6 - expectedSec)).toBeLessThanOrEqual(1 / 30 + 0.025); // AAC priming adds <= 1 audio frame
      if (truth?.width) {
        expect(p.kind).toBe('video');
        expect(p.video!.width).toBe(truth.width);
        expect(p.video!.height).toBe(truth.height);
        if (truth.fps) expect(p.video!.fps).toEqual({ num: truth.fps[0], den: truth.fps[1] });
        if (truth.frames) expect(p.video!.frames).toBe(truth.frames);
        if (truth.codec) expect(p.video!.codec).toBe(truth.codec);
      }
      if (name.endsWith('.wav')) { expect(p.kind).toBe('audio'); expect(p.audio!.sampleRate).toBe(48000); }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  it('fails cleanly on a missing file', async () => {
    await expect(probeMedia('/nonexistent/file.mp4')).rejects.toThrow(/failed/);
  });
});
