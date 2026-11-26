import { describe, it, expect } from 'vitest';
import { exportFps } from '../src';

describe('export frame rate', () => {
  it('keeps the project NTSC rate when the preset is its round twin, else uses the preset', () => {
    expect(exportFps({ num: 30, den: 1 }, { num: 30000, den: 1001 })).toEqual({ num: 30000, den: 1001 });
    expect(exportFps({ num: 60, den: 1 }, { num: 60000, den: 1001 })).toEqual({ num: 60000, den: 1001 });
    expect(exportFps({ num: 30, den: 1 }, { num: 30, den: 1 })).toEqual({ num: 30, den: 1 });
    expect(exportFps({ num: 60, den: 1 }, { num: 30, den: 1 })).toEqual({ num: 60, den: 1 });
    expect(exportFps({ num: 30, den: 1 }, { num: 25, den: 1 })).toEqual({ num: 30, den: 1 });
  });
});
