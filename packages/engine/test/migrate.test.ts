import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrateProject, validateProject, clipEnd, CURRENT_SCHEMA_VERSION } from '../src';

describe('schema migrations', () => {
  it('migrates the committed v0 project to the current schema', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures/project-v0.json'), 'utf8'));
    const { project, from } = migrateProject(raw);
    expect(from).toBe(0);
    expect(project.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(validateProject(project)).toEqual([]);
    expect(project.canvas).toMatchObject({ width: 1080, height: 1920, fps: { num: 30, den: 1 } });
    const cam = project.lanes.find((l) => l.kind === 'camera')!.clips;
    expect(cam.map((c) => [c.start, c.in, c.out])).toEqual([[0, 1_500_000, 9_250_000], [7_750_000, 0, 4_000_000]]);
    expect(clipEnd(cam[1]!)).toBe(9_750_000);
    const voice = project.lanes.find((l) => l.kind === 'voice')!.clips;
    expect(voice[0]!.audio!.gainDb.value).toBe(-18);
    expect(Object.values(project.media).every((m) => m.missing)).toBe(true);
  });

  it('current projects pass through and future ones are refused', () => {
    const raw = JSON.parse(readFileSync(join(__dirname, 'fixtures/project-v0.json'), 'utf8'));
    const { project } = migrateProject(raw);
    expect(migrateProject(JSON.parse(JSON.stringify(project))).from).toBe(CURRENT_SCHEMA_VERSION);
    expect(() => migrateProject({ ...project, schemaVersion: 99 })).toThrow(/newer/);
  });
});
