import { describe, expect, it } from 'vitest';
import { ProjectSchema, validateProject } from '../src';
import { randomProject } from './gen';

describe('project schema round trip', () => {
  it('1000 randomized projects serialize and deserialize deep-equal and valid', () => {
    let clips = 0;
    for (let seed = 1; seed <= 1000; seed++) {
      const p = randomProject(seed);
      clips += p.lanes.reduce((n, l) => n + l.clips.length, 0);
      const json = JSON.stringify(p);
      const back = ProjectSchema.parse(JSON.parse(json));
      expect(back).toEqual(p);
      const again = ProjectSchema.parse(JSON.parse(JSON.stringify(back)));
      expect(JSON.stringify(again)).toBe(JSON.stringify(back));
      expect(json.length).toBe(JSON.stringify(back).length);
      expect(validateProject(back)).toEqual([]);
    }
    expect(clips).toBeGreaterThan(2000);
  });

  it('rejects malformed projects', () => {
    const p = randomProject(7) as unknown as Record<string, unknown>;
    expect(validateProject({ ...p, schemaVersion: 99 }).length).toBeGreaterThan(0);
    expect(validateProject({ ...p, lanes: 'nope' }).length).toBeGreaterThan(0);
  });
});
