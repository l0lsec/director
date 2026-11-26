import { describe, expect, it } from 'vitest';
import { History, validateProject, applyOps, parseOps } from '../src';
import { randomCommand, randomProject, rng } from './gen';

describe('undo/redo exactness', () => {
  it('1000 randomized command sequences undo to the original and redo to the final document', () => {
    let applied = 0;
    const labels = new Map<string, number>();
    for (let seed = 1; seed <= 1000; seed++) {
      const r = rng(seed * 7919);
      const original = randomProject(seed);
      const h = new History(original);
      const steps = r.int(1, 8);
      for (let i = 0; i < steps; i++) {
        const cmd = randomCommand(r, h.doc);
        if (!cmd.ops.length) continue;
        // Ops must survive a JSON round trip (journal, IPC) and schema validation.
        const parsed = parseOps(JSON.parse(JSON.stringify(cmd.ops)));
        expect(parsed.ok).toBe(true);
        h.apply(cmd.ops, cmd.label);
        labels.set(cmd.label, (labels.get(cmd.label) ?? 0) + 1);
        applied++;
        expect(validateProject(h.doc)).toEqual([]);
      }
      const final = structuredClone(h.doc);
      while (h.canUndo) h.undo();
      expect(h.doc).toEqual(original);
      while (h.canRedo) h.redo();
      expect(h.doc).toEqual(final);
    }
    expect(applied).toBeGreaterThan(2500);
    for (const l of ['split', 'ripple', 'trimEnd', 'trimStart', 'move', 'delete', 'insert', 'speed', 'slip', 'bladeAll', 'dup', 'meta']) expect(labels.get(l) ?? 0).toBeGreaterThan(20);
  });

  it('applyOps is all-or-nothing', () => {
    const p = randomProject(3);
    const before = JSON.stringify(p);
    expect(() => applyOps(p, [{ op: 'setMeta', patch: { name: 'ok' } }, { op: 'removeClip', id: 'missing' }])).toThrow();
    expect(JSON.stringify(p)).toBe(before);
  });
});
