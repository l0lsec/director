import { describe, it, expect } from 'vitest';
import { analyzeSpeakers, detectPanels, planSpeakerShots, frameShots, type MouthSample, type SpeechWord } from '../src/speakers';
import { timelineWords } from '../src/transcribe/timeline';
import { newProject, newClip, applyOps, validateProject, speakerLayoutOps, windowTransform, faceWindow, type Project } from '@director/engine';
// The compositor's own placement math, so the test checks what will actually be drawn.
import { placeLayer } from '../../media/src/timeline/plan';

// Two people side by side in a letterboxed 1920x1080 frame (content y 0.25..0.75). Who talks: L 0-10 s, R 10-30 s,
// a quick exchange 30-36 s (L, R, L each 2 s), R 36-45 s. (One-second backchannel like "yeah" is smoothed away on purpose.)
const talk = (t: number): 'L' | 'R' => (t < 10 ? 'L' : t < 30 ? 'R' : t < 36 ? (Math.floor((t - 30) / 2) % 2 === 0 ? 'L' : 'R') : 'R');
function samples(): MouthSample[] {
  const out: MouthSample[] = [];
  for (let i = 0; i < 450; i++) {
    const t = i / 10;
    const open = (who: 'L' | 'R') => (talk(t) === who ? 0.05 + 0.04 * Math.sin(t * 17 + (who === 'L' ? 0 : 1)) : 0.01 + 0.002 * Math.sin(t * 3));
    out.push({ t, faces: [
      { x: 0.2, y: 0.42, w: 0.09, h: 0.15, c: 1, m: open('L') },
      { x: 0.7, y: 0.42, w: 0.09, h: 0.15, c: 1, m: open('R') },
    ] });
  }
  return out;
}
function words(): SpeechWord[] {
  const w: SpeechWord[] = [];
  for (let t = 0.1; t < 45; t += 0.4) w.push({ text: `w${w.length}`, start: Math.round(t * 1e6), end: Math.round((t + 0.3) * 1e6) });
  return w;
}

describe('speaker analysis', () => {
  it('finds two side-by-side panels inside the letterbox', () => {
    const p = detectPanels(samples(), { x: 0, y: 0.25, w: 1, h: 0.5 });
    expect(p).toEqual([{ x: 0, y: 0.25, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.25, w: 0.5, h: 0.5 }]);
  });
  it('finds one panel for a single person', () => {
    const one = samples().map((s) => ({ ...s, faces: [s.faces[0]!] }));
    expect(detectPanels(one)).toHaveLength(1);
  });
  it('tells who speaks, in turns at word boundaries', () => {
    const a = analyzeSpeakers(samples(), words(), { content: { x: 0, y: 0.25, w: 1, h: 0.5 } });
    expect(a.panels).toHaveLength(2);
    const major = a.turns.filter((t) => t.end - t.start > 2e6).map((t) => [t.panel, Math.round(t.start / 1e6), Math.round(t.end / 1e6)]);
    expect(major[0]).toEqual([0, 0, 10]);
    expect(major[1]![0]).toBe(1);
    expect(Math.abs(major[1]![1]! - 10)).toBeLessThanOrEqual(1);
    expect(a.talk[1]).toBeGreaterThan(a.talk[0]!);
    expect(a.confidence).toBeGreaterThan(0.7);
    // Turn boundaries fall on word starts/ends.
    const starts = new Set(words().map((w) => w.start));
    for (const t of a.turns) expect(starts.has(t.start)).toBe(true);
  });
  it('plans solo shots, an all shot for the quick exchange, and alternates framing in long answers', () => {
    const ws = words();
    const a = analyzeSpeakers(samples(), ws, { content: { x: 0, y: 0.25, w: 1, h: 0.5 } });
    const shots = planSpeakerShots(a, ws, 0, 45e6, { minShot: 2.5, maxShot: 9, punchIn: 0.2 });
    // Contiguous and covering the range.
    expect(shots[0]!.start).toBe(0);
    expect(shots[shots.length - 1]!.end).toBe(45e6);
    for (let i = 1; i < shots.length; i++) expect(shots[i]!.start).toBe(shots[i - 1]!.end);
    for (const s of shots) expect(s.end - s.start).toBeGreaterThanOrEqual(2.5e6 - 1);
    for (const s of shots) expect(s.end - s.start).toBeLessThanOrEqual(9e6 * 1.4 + 1);
    const all = shots.filter((s) => s.kind === 'all');
    expect(all.length).toBe(1);
    // In a long answer every 4th framing shows both people (the listener's reaction), when asked.
    const lw = Array.from({ length: 150 }, (_, i) => ({ text: 'w', start: Math.round((0.1 + i * 0.4) * 1e6), end: Math.round((0.4 + i * 0.4) * 1e6) }));
    const mono = { ...a, turns: [{ panel: 1, start: lw[0]!.start, end: lw[149]!.end, words: 150, text: '' }] };
    const r4 = planSpeakerShots(mono, lw, 0, 60e6, { maxShot: 6, reactionEvery: 4 });
    const kinds = r4.map((s) => s.kind);
    expect(kinds.filter((k) => k === 'all').length).toBeGreaterThanOrEqual(2);
    expect(kinds[3]).toBe('all');
    expect(planSpeakerShots(mono, lw, 0, 60e6, { maxShot: 6, reactionEvery: 0 }).every((s) => s.kind === 'solo')).toBe(true);
    expect(Math.abs(all[0]!.start - 30e6)).toBeLessThan(0.3e6);
    expect(Math.abs(all[0]!.end - 36e6)).toBeLessThan(0.3e6);
    const r = shots.filter((s) => s.kind === 'solo' && s.panel === 1) as Array<{ zoom: number }>;
    expect(new Set(r.map((s) => s.zoom))).toEqual(new Set([1, 1.2]));
  });
});

describe('speaker layout ops', () => {
  function project(): { doc: Project; clipId: string } {
    let doc = newProject({ name: 't', canvas: { width: 1920, height: 1080 } });
    doc = applyOps(doc, [{ op: 'addMedia', media: { id: 'm1', path: '/x.mp4', hash: 'h', name: 'x', kind: 'video', durationUs: 60e6, width: 1920, height: 1080, hasAudio: true, hasVideo: true, addedAt: '2026-01-01' } }]).doc;
    const lane = doc.lanes.find((l) => l.kind === 'camera')!;
    const clip = newClip({ kind: 'media', mediaId: 'm1', start: 0, in: 0, out: 45e6 });
    doc = applyOps(doc, [{ op: 'addClip', laneId: lane.id, clip }]).doc;
    return { doc, clipId: clip.id };
  }
  it('frames each person: the face lands at the canvas center for solo shots, in each half side by side', () => {
    const src = { width: 1920, height: 1080 }, canvas = { width: 1920, height: 1080 };
    const panel = { x: 0.5, y: 0.25, w: 0.5, h: 0.5 }, face = { x: 0.7, y: 0.42, w: 0.09, h: 0.15 };
    const fcx = (face.x + face.w / 2) * 1920;
    for (const [slot, zoom] of [[{ x: 0, y: 0, w: 1920, h: 1080 }, 1], [{ x: 0, y: 0, w: 1920, h: 1080 }, 1.2], [{ x: 960, y: 0, w: 960, h: 1080 }, 1]] as const) {
      const win = faceWindow(panel, face, src, slot.w / slot.h, zoom);
      const place = windowTransform(win, src, canvas, slot);
      const clip = newClip({ kind: 'media', start: 0, out: 1e6, ...place });
      const l = placeLayer(clip, 0, 1920, 1080, 1920, 1080, { zoom: 1, shake: { x: 0, y: 0 }, color: null, lut: null, lutStrength: 0, blur: 0, key: null, mask: null } as never, { scale: 1, dx: 0, dy: 0, opacity: 1, blur: 0 } as never);
      // The drawn quad fills the slot exactly.
      expect(Math.abs(l.w - slot.w)).toBeLessThan(0.5);
      expect(Math.abs(l.h - slot.h)).toBeLessThan(0.5);
      expect(Math.abs(l.cx - (slot.x + slot.w / 2))).toBeLessThan(0.5);
      // The face, mapped through the window, sits at the slot's horizontal center unless the panel edge stopped it.
      const faceOnCanvas = l.cx - l.w / 2 + ((fcx - win.x) / win.w) * l.w;
      if (win.x > panel.x * 1920 + 1 && win.x + win.w < (panel.x + panel.w) * 1920 - 1) expect(Math.abs(faceOnCanvas - (slot.x + slot.w / 2))).toBeLessThan(1);
      // The window never leaves the panel.
      expect(win.x).toBeGreaterThanOrEqual(panel.x * 1920 - 0.01);
      expect(win.x + win.w).toBeLessThanOrEqual((panel.x + panel.w) * 1920 + 0.01);
    }
  });
  it('adds muted shot clips on Speakers lanes above the clip, valid and replaceable', () => {
    const { doc, clipId } = project();
    const ws = words();
    const a = analyzeSpeakers(samples(), ws, { content: { x: 0, y: 0.25, w: 1, h: 0.5 } });
    const shots = planSpeakerShots(a, ws, 0, 45e6);
    const r = speakerLayoutOps(doc, clipId, { panels: a.panels, faces: a.faces, shots, names: ['Host', 'Guest'] });
    const after = applyOps(doc, r.ops).doc;
    expect(validateProject(after)).toEqual([]);
    const names = after.lanes.map((l) => l.name);
    const baseIdx = after.lanes.findIndex((l) => l.clips.some((c) => c.id === clipId));
    expect(names.indexOf('Speakers')).toBeLessThan(baseIdx);
    expect(names.indexOf('Speakers 2')).toBeLessThan(baseIdx);
    const made = after.lanes.flatMap((l) => l.clips).filter((c) => (c.meta as { speakerLayout?: string } | undefined)?.speakerLayout === clipId);
    expect(made.length).toBe(r.clips);
    expect(made.every((c) => c.audio?.muted)).toBe(true);
    // Source time matches the base clip at every shot (in sync).
    for (const c of made) expect(c.in - c.start).toBe(0);
    // The muted shots do not repeat the transcript: every word is on the timeline once, from the original clip.
    const withWords = { ...after, transcript: [{ mediaId: 'm1', language: 'en', words: ws }] };
    const tw = timelineWords(withWords);
    expect(tw.length).toBe(ws.length);
    expect(new Set(tw.map((w) => w.clipId))).toEqual(new Set([clipId]));
    // Running it again replaces rather than stacks.
    const again = speakerLayoutOps(after, clipId, { panels: a.panels, faces: a.faces, shots });
    const twice = applyOps(after, again.ops).doc;
    expect(twice.lanes.length).toBe(after.lanes.length);
    expect(twice.lanes.flatMap((l) => l.clips).filter((c) => (c.meta as { speakerLayout?: string } | undefined)?.speakerLayout === clipId).length).toBe(made.length);
  });
});

describe('per-shot framing', () => {
  it('frames each shot on where the face is during that shot', () => {
    // Person 2 sits at x 0.7 for the first 20 s, then leans to x 0.78.
    const ss = samples().map((x) => ({ ...x, faces: [x.faces[0]!, { ...x.faces[1]!, x: x.t < 20 ? 0.7 : 0.78 }] }));
    const ws = words();
    const a = analyzeSpeakers(ss, ws, { content: { x: 0, y: 0.25, w: 1, h: 0.5 } });
    const framed = frameShots(planSpeakerShots(a, ws, 0, 45e6), ss, a);
    const early = framed.find((s) => s.kind === 'solo' && s.panel === 1 && s.end <= 20e6) as { face?: { x: number } } | undefined;
    const late = framed.find((s) => s.kind === 'solo' && s.panel === 1 && s.start >= 21e6) as { face?: { x: number } } | undefined;
    expect(early?.face?.x).toBeCloseTo(0.7, 5);
    expect(late?.face?.x).toBeCloseTo(0.78, 5);
    const all = framed.find((s) => s.kind === 'all') as { faces?: Array<{ x: number } | null> } | undefined;
    expect(all?.faces?.length).toBe(2);
  });
});
