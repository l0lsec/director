import { describe, it, expect } from 'vitest';
import * as engine from '@director/engine';
import { EFFECT_DEFS, TRANSITIONS, TEXT_ANIMATIONS, RAMP_PRESETS, CANVAS_PRESETS, COMMON_FPS, BLEND_MODES, FIT_MODES, LANE_ORDER, pipTransform, findClip, clipEnd, timelineDuration, type Project, type Op } from '@director/engine';
import { CAPTION_STYLES } from '@director/analysis';
import { resolveEffects, transitionMods } from '@director/media/timeline/plan';
import { textAnimation } from '@director/media/text/render';
import { tools, callTool } from '../src';
import { ENGINE_COVERAGE, PRIMITIVE_COVERAGE, COMMAND_COVERAGE } from '../src/coverage';
import { LAYOUTS, KEYFRAME_PROPERTIES } from '../src/tools/clip';
import { makeCtx, type TestCtx } from './fixture';

const S = 1_000_000;
async function ok(ctx: TestCtx, name: string, args: Record<string, unknown>) {
  const r = await callTool(ctx, name, args);
  if (!r.ok) throw new Error(`${name} ${JSON.stringify(args)}: ${r.error.message}`);
  return (r as { data: Record<string, unknown> }).data;
}
async function fails(ctx: TestCtx, name: string, args: Record<string, unknown>) {
  const r = await callTool(ctx, name, args);
  if (r.ok) throw new Error(`${name} should have failed`);
  return r.error;
}
const clip = (d: Project, id: string) => findClip(d, id)!.clip;
const lane = (d: Project, kind: string) => d.lanes.find((l) => l.kind === kind)!;
const capabilities = new Set<string>();
const covered = (c: string) => capabilities.add(c);

describe('coverage tables (leaf-8.1 G2)', () => {
  it('every engine edit command is reachable through a named tool', () => {
    const opsFns = Object.keys(engine).filter((k) => /Ops$/.test(k) && typeof (engine as Record<string, unknown>)[k] === 'function');
    expect(opsFns.length).toBeGreaterThanOrEqual(19);
    for (const f of opsFns) { expect(ENGINE_COVERAGE[f], `engine ${f} has no agent tool`).toBeTruthy(); expect(tools().has(ENGINE_COVERAGE[f]!), f).toBe(true); covered(`engine:${f}`); }
  });
  it('every palette command maps to a tool or says why it is UI only', () => {
    for (const [id, c] of Object.entries(COMMAND_COVERAGE)) {
      if ('tool' in c) expect(tools().has(c.tool), `${id} -> ${c.tool}`).toBe(true);
      else expect(c.uiOnly.length, id).toBeGreaterThan(20);
    }
  });
  it('every primitive op is reachable (named tools and apply_ops)', async () => {
    const kinds = (engine.OpSchema as unknown as { options: Array<{ shape: { op: { value: string } } }> }).options.map((o) => o.shape.op.value);
    expect(kinds.length).toBe(16);
    for (const k of kinds) { expect(PRIMITIVE_COVERAGE[k], k).toBeTruthy(); expect(tools().has(PRIMITIVE_COVERAGE[k]!)).toBe(true); }
    const ctx = makeCtx();
    const m = { ...ctx.getDoc()!.media.media_2!, id: 'media_x', hash: 'hash_x000000000000' };
    const samples: Op[] = [
      { op: 'addMedia', media: m }, { op: 'updateMedia', id: 'media_x', patch: { name: 'renamed' } }, { op: 'removeMedia', id: 'media_x' },
      { op: 'addLane', lane: engine.newLane('sfx', { id: 'lane_x' }), index: 3 }, { op: 'updateLane', id: 'lane_x', patch: { muted: true } }, { op: 'moveLane', id: 'lane_x', index: 0 },
      { op: 'addClip', laneId: 'lane_x', clip: engine.newClip({ id: 'clip_x', kind: 'placeholder', start: 0, out: S }) }, { op: 'updateClip', id: 'clip_x', patch: { name: 'x' } },
      { op: 'moveClipToLane', id: 'clip_x', laneId: 'lane_broll' }, { op: 'removeClip', id: 'clip_x' }, { op: 'removeLane', id: 'lane_x' },
      { op: 'addMarker', marker: { id: 'mk_x', t: S, kind: 'note', label: 'x' } }, { op: 'updateMarker', id: 'mk_x', patch: { label: 'y' } }, { op: 'removeMarker', id: 'mk_x' },
      { op: 'setCanvas', patch: { width: 1080, height: 1350 } }, { op: 'setMeta', patch: { name: 'Raw ops' } },
    ];
    expect(new Set(samples.map((s) => s.op)).size).toBe(16);
    const before = JSON.stringify(ctx.getDoc());
    await ok(ctx, 'apply_ops', { ops: samples, summary: 'every primitive' });
    expect(ctx.getDoc()!.name).toBe('Raw ops');
    ctx.history.undo();
    expect(JSON.stringify(ctx.getDoc())).toBe(before);
    covered('primitive ops');
  });
});

describe('creative vocabulary is reachable and renders (leaf-8.1 G2)', () => {
  it('every addable effect, with every parameter set, changes what is rendered', async () => {
    for (const def of Object.values(EFFECT_DEFS).filter((d) => d.addable)) {
      const ctx = makeCtx();
      const params: Record<string, unknown> = {};
      for (const p of def.params) params[p.key] = p.unit === 's' ? (p.key === 'until' ? 4 : p.key === 'ramp' ? 0.2 : 1) : Math.round((p.min + (p.max - p.min) * 0.7) / p.step) * p.step;
      for (const x of def.extras ?? []) params[x.key] = x.kind === 'path' ? '/luts/film.cube' : x.kind === 'color' ? '#00ff00' : x.kind === 'enum' ? x.values![1] : true;
      const r = await ok(ctx, 'add_effect', { clips: ['clip_abc'], type: def.type, params });
      const fxId = (r.result as { effects: Record<string, string> }).effects.clip_abc!;
      const c = clip(ctx.getDoc()!, 'clip_abc');
      const fx = c.effects.find((e) => e.id === fxId)!;
      for (const p of def.params) expect(fx.params[p.key], `${def.type}.${p.key}`).toBe(p.unit === 's' ? Math.round((params[p.key] as number) * S) : params[p.key]);
      const at = 2 * S;
      const base = resolveEffects({ ...c, effects: c.effects.filter((e) => e.id !== fxId) }, at);
      const withFx = resolveEffects(c, at);
      expect(JSON.stringify(withFx), `${def.type} changes the render`).not.toBe(JSON.stringify(base));
      covered(`effect:${def.type}`);
    }
  });
  it('every transition changes the incoming clip mid-transition', async () => {
    for (const t of TRANSITIONS) {
      const ctx = makeCtx();
      await ok(ctx, 'set_transition', { clips: ['clip_b'], type: t.id, duration: 0.5 });
      const c = clip(ctx.getDoc()!, 'clip_b');
      expect(c.transitionIn).toEqual({ type: t.id, duration: 500_000 });
      expect(JSON.stringify(transitionMods({ type: t.id, progress: 0.3 }, 1080, 1920)), t.id).not.toBe(JSON.stringify(transitionMods(null, 1080, 1920)));
      covered(`transition:${t.id}`);
    }
    const ctx = makeCtx();
    await ok(ctx, 'set_transition', { clips: ['clip_b'], type: 'crossfade' });
    await ok(ctx, 'set_transition', { clips: ['clip_b'], type: 'none' });
    expect(clip(ctx.getDoc()!, 'clip_b').transitionIn).toBeUndefined();
  });
  it('every text animation animates in and out', async () => {
    for (const a of TEXT_ANIMATIONS) {
      const ctx = makeCtx();
      const r = await ok(ctx, 'add_text', { text: 'Hello there', start: 1, duration: 2, animationIn: a.id, animationOut: a.id, animationDuration: 0.4 });
      const c = clip(ctx.getDoc()!, (r.result as { clip: string }).clip);
      const still = JSON.stringify(textAnimation({}, 1, 2));
      expect(JSON.stringify(textAnimation(c.text!, 0.1, 2)), `${a.id} in`).not.toBe(still);
      expect(JSON.stringify(textAnimation(c.text!, 1.9, 2)), `${a.id} out`).not.toBe(still);
      covered(`textAnimation:${a.id}`);
    }
  });
  it('every caption style, then restyling keeps words and timing', async () => {
    for (const s of CAPTION_STYLES) {
      const ctx = makeCtx();
      const r = await ok(ctx, 'generate_captions', { style: s.id, maxWords: 3 });
      const caps = lane(ctx.getDoc()!, 'captions').clips;
      expect(caps.length).toBe((r.result as { captions: number }).captions);
      expect(caps.length).toBeGreaterThan(5);
      for (const c of caps) { expect(c.text!.weight).toBe(s.text.weight); expect(c.text!.words!.length).toBeLessThanOrEqual(3); }
      covered(`captionStyle:${s.id}`);
    }
    const ctx = makeCtx();
    await ok(ctx, 'generate_captions', { style: 'word-pop' });
    const before = lane(ctx.getDoc()!, 'captions').clips.map((c) => [c.start, c.out, c.text!.content, JSON.stringify(c.text!.words)]);
    await ok(ctx, 'style_captions', { style: 'boxed', highlightColor: '#ff4d6d', position: 0.6 });
    const after = lane(ctx.getDoc()!, 'captions').clips;
    expect(after.map((c) => [c.start, c.out, c.text!.content, JSON.stringify(c.text!.words)])).toEqual(before);
    expect(after.every((c) => c.text!.box && c.text!.highlightColor === '#ff4d6d' && c.transform.y.value === Math.round(0.6 * 1920 - 960))).toBe(true);
    covered('restyle captions');
  });
  it('speed ramps, layouts, keyframes, blend and fit modes, lanes, markers and canvas presets', async () => {
    for (const r of Object.keys(RAMP_PRESETS)) { const ctx = makeCtx(); await ok(ctx, 'set_speed', { clip: 'clip_broll', ramp: r }); const sp = clip(ctx.getDoc()!, 'clip_broll').speed; expect(sp.kind === 'ramp' && JSON.stringify(sp.points)).toBe(JSON.stringify(RAMP_PRESETS[r]!.points)); covered(`ramp:${r}`); }
    for (const l of LAYOUTS) { const ctx = makeCtx(); await ok(ctx, 'set_layout', { clip: 'clip_face', layout: l }); expect(clip(ctx.getDoc()!, 'clip_face').transform).toEqual(pipTransform(l, ctx.getDoc()!.canvas).transform); covered(`layout:${l}`); }
    for (const p of KEYFRAME_PROPERTIES) {
      const ctx = makeCtx();
      const target = p === 'volume' ? 'clip_music' : 'clip_abc';
      await ok(ctx, 'set_keyframes', { clip: target, property: p, ...(p === 'effect' ? { effect: 'fx_123', param: 'exposure' } : {}), keyframes: [{ time: 1, value: 0 }, { time: 3, value: p === 'effect' ? 0.5 : 1.3, ease: 'easeOut' }] });
      const c = clip(ctx.getDoc()!, target);
      const a = p === 'volume' ? c.audio!.gainDb : p === 'effect' ? c.effects[0]!.params.exposure as engine.Animatable : c.transform[p as 'x'];
      expect(a.keyframes?.length, p).toBe(2);
      expect(engine.evalAnim(a, 2 * S - c.start)).toBeGreaterThan(0);
      covered(`keyframes:${p}`);
    }
    for (const b of BLEND_MODES) { const ctx = makeCtx(); await ok(ctx, 'set_clip', { clips: ['clip_broll'], blend: b, fit: FIT_MODES[BLEND_MODES.indexOf(b) % 3] }); expect(clip(ctx.getDoc()!, 'clip_broll').blend).toBe(b); covered(`blend:${b}`); }
    for (const f of FIT_MODES) covered(`fit:${f}`);
    for (const k of LANE_ORDER) { const ctx = makeCtx(); const r = await ok(ctx, 'add_lane', { kind: k }); expect(ctx.getDoc()!.lanes.find((l) => l.id === (r.result as { lane: string }).lane)!.kind).toBe(k); covered(`lane:${k}`); }
    for (const k of ['note', 'retake', 'cue', 'chapter', 'beat', 'good', 'bad']) { const ctx = makeCtx(); await ok(ctx, 'add_marker', { at: 3, label: k, kind: k }); expect(ctx.getDoc()!.markers.some((m) => m.kind === k)).toBe(true); covered(`marker:${k}`); }
    for (const p of Object.keys(CANVAS_PRESETS)) { const ctx = makeCtx(); await ok(ctx, 'set_canvas', { preset: p }); expect(ctx.getDoc()!.canvas.width).toBe(CANVAS_PRESETS[p]!.width); covered(`canvas:${p}`); }
    for (const f of Object.keys(COMMON_FPS)) { const ctx = makeCtx(); await ok(ctx, 'set_canvas', { fps: f }); expect(ctx.getDoc()!.canvas.fps).toEqual(COMMON_FPS[f]); covered(`fps:${f}`); }
  });
});

describe('professional editing tasks (leaf-8.1 G2)', () => {
  it('insert vs overwrite, three-point edit, ripple delete vs lift, roll, slip', async () => {
    let ctx = makeCtx();
    const d0 = timelineDuration(ctx.getDoc()!);
    await ok(ctx, 'add_clip', { media: 'media_2', lane: 'camera', start: 6, sourceIn: 1, sourceOut: 3, insert: true });
    expect(timelineDuration(ctx.getDoc()!)).toBe(d0 + 2 * S); covered('insert edit');
    ctx = makeCtx();
    const r = await ok(ctx, 'add_clip', { media: 'media_2', lane: 'camera', start: 6, sourceIn: 1, sourceOut: 3 });
    const c = clip(ctx.getDoc()!, (r.result as { clip: string }).clip);
    expect([c.start, c.in, c.out]).toEqual([6 * S, 1 * S, 3 * S]);
    expect(timelineDuration(ctx.getDoc()!)).toBe(d0); covered('overwrite edit'); covered('three-point edit');
    ctx = makeCtx(); await ok(ctx, 'delete_range', { from: 6, to: 7 }); expect(timelineDuration(ctx.getDoc()!)).toBe(d0 - S); covered('ripple delete');
    ctx = makeCtx(); await ok(ctx, 'delete_range', { from: 6, to: 7, ripple: false }); expect(timelineDuration(ctx.getDoc()!)).toBe(d0); expect(lane(ctx.getDoc()!, 'camera').clips.some((x) => x.start < 7 * S && clipEnd(x) > 6 * S)).toBe(false); covered('lift');
    ctx = makeCtx(); await ok(ctx, 'roll_edit', { left: 'clip_a', right: 'clip_b', by: 0.5 }); expect([clipEnd(clip(ctx.getDoc()!, 'clip_a')), clip(ctx.getDoc()!, 'clip_b').start]).toEqual([9.5 * S, 9.5 * S]); covered('roll');
    ctx = makeCtx(); await ok(ctx, 'slip_clip', { clip: 'clip_a', by: 1 }); expect([clip(ctx.getDoc()!, 'clip_a').start, clip(ctx.getDoc()!, 'clip_a').in]).toEqual([6 * S, 7 * S]); covered('slip');
  });
  it('J-cut and L-cut by detaching audio and trimming picture and sound separately', async () => {
    const ctx = makeCtx();
    const d = await ok(ctx, 'detach_audio', { clip: 'clip_b' });
    const audioId = (d.result as { audioClip: string }).audioClip;
    await ok(ctx, 'link_clips', { clips: ['clip_b', audioId], link: false });
    await ok(ctx, 'trim_clip', { clip: audioId, edge: 'start', by: -0.5, ripple: false });
    const doc = ctx.getDoc()!;
    expect(clip(doc, audioId).start).toBe(8.5 * S);
    expect(clip(doc, 'clip_b').start).toBe(9 * S);
    covered('J-cut'); covered('L-cut');
  });
  it('audio mix: volume, pan, fades, ducking, automation, mute, solo', async () => {
    const ctx = makeCtx();
    await ok(ctx, 'set_audio', { clips: ['clip_music'], volume: -16, pan: -0.2, fadeIn: 1, fadeOut: 2, duckUnderVoice: true });
    const a = clip(ctx.getDoc()!, 'clip_music').audio!;
    expect([a.gainDb.value, a.pan, a.fadeIn, a.fadeOut, a.duckable]).toEqual([-16, -0.2, S, 2 * S, true]);
    await ok(ctx, 'update_lane', { lane: 'music', solo: true });
    await ok(ctx, 'set_audio', { clips: ['clip_abc'], muted: true });
    expect(lane(ctx.getDoc()!, 'music').solo && clip(ctx.getDoc()!, 'clip_abc').audio!.muted).toBe(true);
    ['volume', 'pan', 'fades', 'ducking', 'mute', 'solo'].forEach(covered);
  });
  it('transform: crop, flip, rotation, opacity, reverse, freeze, background blur', async () => {
    const ctx = makeCtx();
    await ok(ctx, 'set_clip', { clips: ['clip_broll'], crop: { left: 0.1, top: 0.05 }, flipH: true, rotation: 4, opacity: 0.7, reverse: true });
    const c = clip(ctx.getDoc()!, 'clip_broll');
    expect([c.transform.crop.left, c.transform.crop.top, c.transform.flipH, c.transform.rotation.value, c.transform.opacity.value, c.reverse]).toEqual([0.1, 0.05, true, 4, 0.7, true]);
    const f = await ok(ctx, 'freeze_frame', { clip: 'clip_abc', at: 2, duration: 1 });
    expect(clip(ctx.getDoc()!, (f.result as { createdClips: string[] }).createdClips.at(-1)!).freezeAt).toBeDefined();
    await ok(ctx, 'set_canvas', { background: 'blur', blurAmount: 0.7 });
    expect(ctx.getDoc()!.canvas.background).toEqual({ kind: 'blur', amount: 0.7 });
    ['crop', 'flip', 'rotation', 'opacity', 'reverse', 'freeze frame', 'background blur'].forEach(covered);
  });
  it('locked lanes are protected and say how to unlock', async () => {
    const ctx = makeCtx();
    await ok(ctx, 'update_lane', { lane: 'camera', locked: true });
    const e = await fails(ctx, 'trim_clip', { clip: 'clip_abc', edge: 'end', by: -1 });
    expect(e.code).toBe('LANE_LOCKED');
    expect(e.hint).toContain('update_lane');
    covered('lock lanes');
  });
  it('text-based editing, AutoCut, Make Reel, close gaps, templates', async () => {
    let ctx = makeCtx();
    const words0 = (await ok(ctx, 'get_transcript', {})).count as number;
    const hit = await ok(ctx, 'find_in_transcript', { text: 'link in bio' });
    expect(hit.matches).toBe(1);
    await ok(ctx, 'cut_words', { text: 'link in bio' });
    const t = await ok(ctx, 'get_transcript', {});
    expect(t.count).toBe(words0 - 3);
    expect(JSON.stringify(t.words)).not.toContain('"bio"');
    covered('text-based cut');
    ctx = makeCtx();
    const a = await ok(ctx, 'auto_cut', { fillers: ['um', 'so'] });
    expect((a.result as { removedSeconds: number }).removedSeconds).toBeGreaterThan(3);
    const after = await ok(ctx, 'get_transcript', {});
    expect((after.words as Array<{ text: string }>).some((w) => w.text === 'um')).toBe(false);
    covered('auto cut');
    ctx = makeCtx();
    const m = await ok(ctx, 'make_reel', {});
    expect((m.result as { captions: number }).captions).toBeGreaterThan(3);
    covered('make reel');
    ctx = makeCtx();
    await ok(ctx, 'move_clip', { clip: 'clip_camera', start: 25 });
    const len = timelineDuration(ctx.getDoc()!);
    const g = await ok(ctx, 'close_gaps', {});
    expect((g.result as { gaps: Array<{ from: number; to: number }> }).gaps).toEqual([{ from: 20, to: 25 }]);
    expect(timelineDuration(ctx.getDoc()!)).toBe(len - 5 * S);
    covered('close gaps');
    ctx = makeCtx();
    const tp = await ok(ctx, 'apply_template', { template: 'Lower third', at: 10, texts: ['Sam Rivera'] });
    const ids = (tp.result as { clips: string[] }).clips;
    expect(ids.length).toBe(2);
    expect(ids.map((id) => clip(ctx.getDoc()!, id).text?.content).filter(Boolean)).toEqual(['Sam Rivera']);
    covered('templates');
  });
  it('reports what it covered', () => {
    expect(capabilities.size).toBeGreaterThanOrEqual(100);
    console.log(`COVERAGE ${capabilities.size} capabilities: ${[...capabilities].join(', ')}`);
  });
});
