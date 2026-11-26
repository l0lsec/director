import { describe, it, expect } from 'vitest';
import { findClip } from '@director/engine';
import { callTool } from '../src';
import { makeCtx } from './fixture';

const STEPS = [
  { tool: 'add_effect', args: { clips: ['clip_abc', 'clip_a'], type: 'color', params: { contrast: 0.2, temperature: 0.1 } } },
  { tool: 'set_transition', args: { clips: ['clip_b'], type: 'crossfade', duration: 0.3 } },
  { tool: 'add_text', args: { text: 'Watch this', start: 0, duration: 2 } },
  { tool: 'set_audio', args: { clips: ['clip_music'], volume: -18, duckUnderVoice: true, fadeOut: 2 } },
  { tool: 'trim_clip', args: { clip: 'clip_camera', edge: 'end', by: -1 } },
  { tool: 'add_marker', args: { at: 3, label: 'Hook ends', kind: 'chapter' } },
];

describe('batch (leaf-8.1 G4)', () => {
  it('applies many edits as one approval and one undo step', async () => {
    const ctx = makeCtx();
    const before = JSON.stringify(ctx.getDoc());
    const r = await callTool(ctx, 'batch', { label: 'Polish pass', steps: STEPS });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const data = (r as { data: { applied: boolean; result: { steps: unknown[] } } }).data;
    expect(data.applied).toBe(true);
    expect(data.result.steps.length).toBe(STEPS.length);
    expect(ctx.approvals.length).toBe(1);
    expect(ctx.approvals[0]!.summary).toBe('Polish pass');
    expect(ctx.history.depth).toBe(1);
    const d = ctx.getDoc()!;
    expect(findClip(d, 'clip_b')!.clip.transitionIn?.type).toBe('crossfade');
    expect(findClip(d, 'clip_music')!.clip.audio!.duckable).toBe(true);
    expect(d.markers.some((m) => m.label === 'Hook ends')).toBe(true);
    ctx.history.undo();
    expect(JSON.stringify(ctx.getDoc())).toBe(before);
  });

  it('later steps see earlier ones (a step can use what a previous step changed)', async () => {
    const ctx = makeCtx();
    const r = await callTool(ctx, 'batch', { label: 'Speed then trim', steps: [
      { tool: 'set_speed', args: { clip: 'clip_a', rate: 2 } },
      { tool: 'trim_clip', args: { clip: 'clip_a', edge: 'end', to: 7 } },
    ] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const c = findClip(ctx.getDoc()!, 'clip_a')!.clip;
    expect(c.speed).toMatchObject({ kind: 'constant', rate: 2 });
    expect(c.start + (c.out - c.in) / 2).toBe(7_000_000);
  });

  it('a failing step changes nothing and is named', async () => {
    const ctx = makeCtx();
    const before = JSON.stringify(ctx.getDoc());
    const bad = [...STEPS.slice(0, 3), { tool: 'trim_clip', args: { clip: 'clip_nope', edge: 'end', by: -1 } }, ...STEPS.slice(3)];
    const r = await callTool(ctx, 'batch', { label: 'Broken', steps: bad });
    expect(r.ok).toBe(false);
    const e = (r as { error: { code: string; message: string; hint?: string } }).error;
    expect(e.message).toMatch(/^Step 4 \(trim_clip\) failed: No clip "clip_nope"/);
    expect(e.message).toContain('Nothing was changed');
    expect(e.hint).toBeTruthy();
    expect(JSON.stringify(ctx.getDoc())).toBe(before);
    expect(ctx.approvals.length).toBe(0);
    for (const [steps, re] of [
      [[{ tool: 'get_timeline', args: {} }], /not an edit tool/],
      [[{ tool: 'batch', args: { label: 'x', steps: [] } }], /not an edit tool/],
      [[{ tool: 'nope' }], /no tool called nope/],
      [[{ tool: 'split', args: { at: 'soon' } }], /^Step 1 \(split\): at/],
    ] as const) {
      const x = await callTool(ctx, 'batch', { label: 'x', steps });
      expect(x.ok).toBe(false);
      expect((x as { error: { message: string } }).error.message).toMatch(re);
    }
    expect(JSON.stringify(ctx.getDoc())).toBe(before);
  });

  it('dry run previews the whole batch', async () => {
    const ctx = makeCtx();
    const doc = ctx.getDoc();
    const r = await callTool(ctx, 'batch', { label: 'Preview', steps: STEPS, dryRun: true });
    expect(r.ok).toBe(true);
    const data = (r as { data: { dryRun: boolean; changes: { clipsAdded?: string[]; clipsChanged?: string[] } } }).data;
    expect(data.dryRun).toBe(true);
    expect(data.changes.clipsAdded?.length).toBe(1);
    expect(data.changes.clipsChanged?.length).toBeGreaterThanOrEqual(5);
    expect(ctx.getDoc()).toBe(doc);
  });

  it('a stale expectRevision is refused; the current one is accepted', async () => {
    const ctx = makeCtx();
    const tl = await callTool(ctx, 'get_timeline', {});
    const rev = (tl as { data: { revision: number } }).data.revision;
    // The person edits in the app meanwhile.
    ctx.apply([{ op: 'setMeta', patch: { name: 'Edited by hand' } }], 'rename');
    const before = JSON.stringify(ctx.getDoc());
    const stale = await callTool(ctx, 'split', { at: 3, expectRevision: rev });
    expect(stale.ok).toBe(false);
    const e = (stale as { error: { code: string; message: string; hint: string } }).error;
    expect(e.code).toBe('STALE');
    expect(e.message).toContain(`revision ${rev}`);
    expect(e.hint).toContain('get_timeline');
    expect(JSON.stringify(ctx.getDoc())).toBe(before);
    const fresh = await callTool(ctx, 'split', { at: 3, expectRevision: ctx.revision() });
    expect(fresh.ok).toBe(true);
    const staleBatch = await callTool(ctx, 'batch', { label: 'x', steps: STEPS, expectRevision: rev });
    expect(staleBatch.ok).toBe(false);
  });

  it('when the person edits while deciding, the change is planned again on what is there', async () => {
    const ctx = makeCtx();
    ctx.decide = () => { ctx.history.apply([{ op: 'updateClip', id: 'clip_abc', patch: { name: 'renamed meanwhile' } }], 'person'); return { ok: true }; };
    const r = await callTool(ctx, 'set_clip', { clips: ['clip_abc'], opacity: 0.5 });
    expect(r.ok).toBe(true);
    const c = findClip(ctx.getDoc()!, 'clip_abc')!.clip;
    expect([c.name, c.transform.opacity.value]).toEqual(['renamed meanwhile', 0.5]);
  });
});

describe('overlap warning', () => {
  it('says when placing text cuts into a clip already on the lane, and stays quiet otherwise', async () => {
    const ctx = makeCtx();
    const own = await callTool(ctx, 'add_lane', { kind: 'titles', name: 'Titles A' });
    const a = own.ok ? (own.data as { result: { lane: string } }).result.lane : '';
    const first = await callTool(ctx, 'add_text', { text: 'Name', start: 2, duration: 4, lane: a });
    expect(first.ok && (first.data as { warning?: string }).warning).toBeFalsy();
    const second = await callTool(ctx, 'add_text', { text: 'Role', start: 3, duration: 4, lane: a });
    const w = second.ok ? (second.data as { warning?: string }).warning : undefined;
    expect(w).toMatch(/overlapped 1 clip/);
    expect(w).toMatch(/add_lane/);
    const lane = await callTool(ctx, 'add_lane', { kind: 'titles', name: 'Titles 2' });
    const id = lane.ok ? (lane.data as { result: { lane: string } }).result.lane : '';
    const third = await callTool(ctx, 'add_text', { text: 'Role', start: 3, duration: 4, lane: id });
    expect(third.ok && (third.data as { warning?: string }).warning).toBeFalsy();
  });
});

describe('get_timeline lane filter', () => {
  it('a kind lists every lane of that kind', async () => {
    const ctx = makeCtx();
    await callTool(ctx, 'add_lane', { kind: 'titles', name: 'Titles 2' });
    const r = await callTool(ctx, 'get_timeline', { lanes: ['titles'] });
    const names = r.ok ? (r.data as { lanes: Array<{ name: string; kind: string }> }).lanes.map((l) => l.kind) : [];
    expect(names.filter((k) => k === 'titles').length).toBe(ctx.getDoc()!.lanes.filter((l) => l.kind === 'titles').length);
    expect(names.length).toBeGreaterThanOrEqual(2);
    const one = await callTool(ctx, 'get_timeline', { lanes: ['Titles 2'] });
    expect(one.ok && (one.data as { lanes: unknown[] }).lanes.length).toBe(1);
  });
});
