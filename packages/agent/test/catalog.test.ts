import { describe, it, expect } from 'vitest';
import { ProjectSchema, validateProject } from '@director/engine';
import { tools, callTool, manifest, annotations } from '../src';
import { makeCtx } from './fixture';

/** Tools whose examples need earlier state (captions exist before restyling them). */
export const SETUP: Record<string, Array<[string, Record<string, unknown>]>> = {
  style_captions: [['generate_captions', {}]],
  export_subtitles: [['generate_captions', {}]],
  export_chapters: [['add_marker', { at: 6, label: 'The story', kind: 'chapter' }], ['add_marker', { at: 12, label: 'The ask', kind: 'chapter' }]],
};

async function prepared(name: string) {
  const ctx = makeCtx();
  for (const [t, a] of SETUP[name] ?? []) {
    const r = await callTool(ctx, t, a);
    if (!r.ok) throw new Error(`setup ${t}: ${r.error.message}`);
  }
  ctx.approvals.length = 0;
  return ctx;
}

const all = [...tools().values()];
const edits = all.filter((t) => t.access === 'edit');
const others = all.filter((t) => t.access !== 'edit');

describe('catalog shape (leaf-8.1 G3)', () => {
  it('has unique snake_case names, descriptions with units, annotations and schemas', () => {
    expect(all.length).toBeGreaterThanOrEqual(70);
    for (const t of all) {
      expect(t.name, t.name).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
      expect(t.description.length, `${t.name} description`).toBeGreaterThanOrEqual(60);
      expect(t.examples.length, `${t.name} examples`).toBeGreaterThanOrEqual(1);
      const shape = t.input.shape as Record<string, unknown>;
      const isNumber = (f: unknown): boolean => { let x = f as { def?: { type?: string; innerType?: unknown } }; while (x?.def?.type === 'optional' || x?.def?.type === 'nullable') x = x.def.innerType as typeof x; return x?.def?.type === 'number'; };
      const timeArgs = Object.keys(shape).filter((k) => ['at', 'start', 't', 'from', 'to', 'by', 'duration', 'sourceIn', 'sourceOut', 'fadeIn', 'fadeOut', 'minPause', 'keep', 'minGap'].includes(k) && isNumber(shape[k]));
      if (timeArgs.length) expect(t.description.toLowerCase(), `${t.name} states units`).toMatch(/second/);
      const a = annotations(t);
      expect(typeof a.readOnlyHint).toBe('boolean');
      if (t.access === 'read') expect(a.readOnlyHint).toBe(true);
      if (t.access === 'edit') expect(a.readOnlyHint).toBe(false);
    }
    for (const fmt of ['mcp', 'anthropic', 'openai'] as const) {
      const m = manifest(fmt) as Array<Record<string, unknown>>;
      expect(m.length).toBe(all.length);
      for (const e of m) {
        const schema = (fmt === 'mcp' ? e.inputSchema : fmt === 'anthropic' ? e.input_schema : (e.function as Record<string, unknown>).parameters) as Record<string, unknown>;
        expect(schema.type).toBe('object');
        expect(JSON.stringify(schema)).not.toContain('$schema');
      }
    }
  });

  it('every example validates against its schema', () => {
    let n = 0;
    for (const t of all) for (const ex of t.examples) { const r = t.input.safeParse(ex.args); expect(r.success, `${t.name} ${JSON.stringify(ex.args)}: ${r.success ? '' : r.error.message}`).toBe(true); n++; }
    expect(n).toBeGreaterThanOrEqual(all.length);
  });
});

describe('edit tools (leaf-8.1 G1)', () => {
  for (const t of edits) {
    t.examples.forEach((ex, i) => {
      it(`${t.name} #${i + 1}: valid result, exact undo`, async () => {
        const ctx = await prepared(t.name);
        const before = JSON.stringify(ctx.getDoc());
        const r = await callTool(ctx, t.name, ex.args);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        const data = (r as { data: Record<string, unknown> }).data;
        const after = ctx.getDoc()!;
        expect(ProjectSchema.safeParse(after).success).toBe(true);
        expect(validateProject(after)).toEqual([]);
        if (data.applied) {
          expect(JSON.stringify(after)).not.toBe(before);
          expect(ctx.approvals.length).toBe(1);
          ctx.history.undo();
          expect(JSON.stringify(ctx.getDoc())).toBe(before);
        } else {
          expect(JSON.stringify(after)).toBe(before);
        }
      });
      it(`${t.name} #${i + 1}: dry run changes nothing`, async () => {
        const ctx = await prepared(t.name);
        const doc = ctx.getDoc();
        const rev = ctx.revision();
        const r = await callTool(ctx, t.name, { ...ex.args, dryRun: true });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(ctx.getDoc()).toBe(doc);
        expect(ctx.revision()).toBe(rev);
        expect(ctx.approvals.length).toBe(0);
      });
      it(`${t.name} #${i + 1}: a rejected change changes nothing`, async () => {
        const ctx = await prepared(t.name);
        ctx.decide = () => ({ ok: false });
        const before = JSON.stringify(ctx.getDoc());
        const r = await callTool(ctx, t.name, ex.args);
        expect(r.ok).toBe(true);
        expect(JSON.stringify(ctx.getDoc())).toBe(before);
      });
    });
  }
});

describe('read and app tools run their examples', () => {
  for (const t of others) {
    t.examples.forEach((ex, i) => {
      it(`${t.name} #${i + 1}`, async () => {
        const ctx = await prepared(t.name);
        const before = JSON.stringify(ctx.getDoc());
        const r = await callTool(ctx, t.name, ex.args);
        expect(r.ok, JSON.stringify(r)).toBe(true);
        if (t.access === 'read') { expect(JSON.stringify(ctx.getDoc())).toBe(before); expect(ctx.approvals.length).toBe(0); }
        // A mutating action asks once, unless it was asked as a dry run (which changes nothing).
        if (t.access === 'act') expect(ctx.approvals.length).toBe(t.mutates && (ex.args as { dryRun?: boolean }).dryRun !== true ? 1 : 0);
      });
    });
  }

  it('mutating app tools do nothing when the person declines', async () => {
    for (const t of others.filter((x) => x.mutates)) {
      const ctx = await prepared(t.name);
      ctx.decide = () => ({ ok: false });
      const before = JSON.stringify(ctx.getDoc());
      const r = await callTool(ctx, t.name, t.examples[0]!.args);
      expect(r.ok, t.name).toBe(true);
      expect((r as { data: { rejected?: boolean } }).data.rejected, t.name).toBe(true);
      expect(JSON.stringify(ctx.getDoc()), t.name).toBe(before);
    }
  });
});
