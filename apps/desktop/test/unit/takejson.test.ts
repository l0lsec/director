import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TakeSchema } from '@director/engine';

const dir = process.env.DIRECTOR_TAKE_DIR;

describe.skipIf(!dir)('recorded take.json', () => {
  it('is schema-valid with script, devices, clock, markers and alignment', () => {
    const take = TakeSchema.parse(JSON.parse(readFileSync(join(dir!, 'take.json'), 'utf8')));
    expect(take.status).toBe('ok');
    expect(take.script?.text.length).toBeGreaterThan(10);
    expect(take.devices.camera?.width).toBeGreaterThan(0);
    expect(take.devices.mic?.label).toBeTruthy();
    expect(take.clock.cameraStartMs).toBeGreaterThan(1.7e12);
    expect(take.durationUs).toBeGreaterThan(4_000_000);
    expect(take.markers.some((m) => m.kind === 'retake' && m.line != null)).toBe(true);
    expect(take.markers.some((m) => m.kind === 'note')).toBe(true);
    expect(take.markers.some((m) => m.kind === 'cue')).toBe(true);
    expect(take.alignment.length).toBeGreaterThan(3);
    for (let i = 1; i < take.alignment.length; i++) expect(take.alignment[i]!.t).toBeGreaterThanOrEqual(take.alignment[i - 1]!.t);
    expect(take.recorder.chunks).toBeGreaterThan(3);
  });
});
