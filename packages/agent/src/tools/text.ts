import { z } from 'zod';
import { TEXT_ANIMATIONS, clipEnd, insertClipOps, laneOfKind, newClip, type Clip, type Op, type TextSpec } from '@director/engine';
import { CAPTION_STYLES, DEFAULT_CAPTIONS, captionLayout, captionOps, timelineWords } from '@director/analysis';
import { AgentError, defineEdit } from '../core';
import { Color, LaneRef, Ref, Seconds, clipRef, frameUs, laneRef, sec, us } from '../units';

const ANIMS = TEXT_ANIMATIONS.map((a) => a.id) as [string, ...string[]];
const AnimIn = z.enum([...ANIMS, 'none'] as [string, ...string[]]);

const TextStyle = {
  font: z.string().min(1).max(120).optional().describe('Font family, e.g. Inter'),
  size: z.number().min(8).max(600).optional().describe('Font size in project pixels (a 1080x1920 frame: 60 small, 96 bold title)'),
  weight: z.number().int().min(100).max(1000).optional(),
  color: Color.optional(),
  highlightColor: Color.optional().describe('Color of the word being spoken (captions)'),
  align: z.enum(['left', 'center', 'right']).optional(),
  uppercase: z.boolean().optional(),
  stroke: z.object({ color: Color, width: z.number().min(0).max(100) }).nullable().optional().describe('Outline; null removes it'),
  shadow: z.object({ color: Color, blur: z.number().min(0).max(100), x: z.number(), y: z.number() }).nullable().optional(),
  box: z.object({ color: Color, padding: z.number().min(0).max(200), radius: z.number().min(0).max(200) }).nullable().optional().describe('Background box behind the text; null removes it'),
  lineHeight: z.number().min(0.6).max(4).optional(),
  maxWidth: z.number().min(0.1).max(1).optional().describe('Wrap width as a fraction of the frame width'),
  animationIn: AnimIn.optional(), animationOut: AnimIn.optional(),
  animationDuration: z.number().min(0).max(5).optional().describe('Seconds for the in and out animations'),
};
type StyleArgs = { [K in keyof typeof TextStyle]?: z.output<(typeof TextStyle)[K]> };

function applyStyle(base: TextSpec, s: StyleArgs): TextSpec {
  const t: TextSpec = { ...base };
  for (const k of ['font', 'size', 'weight', 'color', 'highlightColor', 'align', 'uppercase', 'lineHeight', 'maxWidth'] as const) if (s[k] !== undefined) (t as Record<string, unknown>)[k] = s[k];
  for (const k of ['stroke', 'shadow', 'box'] as const) {
    if (s[k] === null) delete t[k];
    else if (s[k] !== undefined) (t as Record<string, unknown>)[k] = s[k];
  }
  for (const k of ['animationIn', 'animationOut'] as const) {
    if (s[k] === 'none') delete t[k];
    else if (s[k] !== undefined) t[k] = s[k];
  }
  if (s.animationDuration !== undefined) t.animationDuration = us(s.animationDuration);
  return t;
}

const TITLE_DEFAULT: TextSpec = { content: '', font: 'Inter', size: 96, weight: 900, color: '#ffffff', align: 'center', lineHeight: 1.05, maxWidth: 0.86, stroke: { color: '#000000', width: 6 }, animationIn: 'pop', animationOut: 'fade', animationDuration: 250_000 };

export const textTools = [
  defineEdit({
    name: 'add_text', title: 'Add a title or text', group: 'text',
    description: 'Add a text clip (title, label, lower third, call to action) at `start` seconds for `duration` seconds on the titles lane (or `lane`). x/y move it in project pixels from the frame center (+y is down). Defaults: Inter 96 px, weight 900, white with a black outline, pops in and fades out. Animations: ' + ANIMS.join(', ') + '. Animate position or scale with set_keyframes.',
    input: {
      text: z.string().min(1).max(5000), start: Seconds, duration: z.number().min(0.04).max(36_000).optional().describe('Seconds (default 3)'),
      lane: LaneRef.optional(), x: z.number().optional(), y: z.number().optional(), name: z.string().max(200).optional(),
      ...TextStyle,
    },
    examples: [
      { args: { text: 'Stop typing plain prompts', start: 0.2, duration: 2.8, y: -620 }, note: 'Hook title near the top' },
      { args: { text: 'Follow for part 2', start: 24, duration: 3, box: { color: 'rgba(0,0,0,0.7)', padding: 24, radius: 18 }, size: 64, animationIn: 'slide-up' } },
    ],
    plan: (doc, a) => {
      const lane = laneRef(doc, a.lane ?? 'titles', { unlocked: true });
      const start = frameUs(doc, a.start);
      const out = us(a.duration ?? 3);
      const text = applyStyle({ ...TITLE_DEFAULT, content: a.text }, a);
      const clip = newClip({ kind: 'text', start, in: 0, out, name: a.name ?? a.text.slice(0, 60), text });
      if (a.x != null || a.y != null) clip.transform = { ...clip.transform, x: { value: a.x ?? 0 }, y: { value: a.y ?? 0 } };
      return { ops: insertClipOps(doc, lane.id, clip, false), summary: `Add text "${a.text.slice(0, 40)}" at ${sec(start)} s`, result: { clip: clip.id, lane: lane.id } };
    },
  }),

  defineEdit({
    name: 'update_text', title: 'Edit text or its style', group: 'text', idempotent: true,
    description: 'Change the words and/or style of text or caption clips: content, font, size, weight, colors, outline, shadow, box, alignment, uppercase, wrap width and in/out animations. Changing a caption\'s words drops its word timing (the highlight then covers the whole card).',
    input: { clips: z.array(Ref).min(1).max(500), text: z.string().min(1).max(5000).optional(), ...TextStyle },
    examples: [{ args: { clips: ['clip_title'], text: 'Here is the trick', color: '#f5e23d' } }, { args: { clips: ['clip_title'], animationIn: 'typewriter', animationDuration: 0.6 } }],
    plan: (doc, a) => {
      const ops: Op[] = a.clips.map((id) => {
        const { clip } = clipRef(doc, id, { unlocked: true });
        if (!clip.text) throw new AgentError('NOT_TEXT', `Clip ${id} is a ${clip.kind} clip, not text.`, 'update_text works on text and caption clips; use set_clip for others.');
        let t = applyStyle(clip.text, a);
        if (a.text != null && a.text !== clip.text.content) { t = { ...t, content: a.text }; delete t.words; }
        return { op: 'updateClip' as const, id, patch: { text: t, ...(a.text != null && clip.kind === 'text' ? { name: a.text.slice(0, 60) } : {}) } };
      });
      return { ops, summary: `Edit ${a.clips.length} text clip(s)` };
    },
  }),

  defineEdit({
    name: 'add_shape', title: 'Add a shape', group: 'text',
    description: 'Add a solid rectangle or ellipse (for highlights, bars, frames behind text) on the graphics lane at `start` for `duration` seconds (default 3). size is its width as a fraction of the frame (it keeps the frame\'s aspect; stretch it with set_clip scale or keyframes); x/y in project pixels from center; radius rounds rectangle corners.',
    input: { shape: z.enum(['rect', 'ellipse']), color: Color, start: Seconds, duration: z.number().min(0.04).max(36_000).optional(), size: z.number().min(0.01).max(4).optional(), radius: z.number().min(0).max(500).optional(), x: z.number().optional(), y: z.number().optional(), opacity: z.number().min(0).max(1).optional(), lane: LaneRef.optional() },
    examples: [{ args: { shape: 'rect', color: '#f5e23d', start: 2, duration: 2, size: 0.6, radius: 24, y: 500, opacity: 0.9 } }],
    plan: (doc, a) => {
      const lane = laneRef(doc, a.lane ?? 'graphics', { unlocked: true });
      const start = frameUs(doc, a.start);
      const clip = newClip({ kind: 'shape', start, in: 0, out: us(a.duration ?? 3), name: `${a.shape}`, shape: { type: a.shape, color: a.color, radius: a.radius ?? 0 } });
      clip.transform = { ...clip.transform, scale: { value: (a.size ?? 0.25) / 0.25 }, x: { value: a.x ?? 0 }, y: { value: a.y ?? 0 }, opacity: { value: a.opacity ?? 1 } };
      return { ops: insertClipOps(doc, lane.id, clip, false), summary: `Add ${a.shape}`, result: { clip: clip.id } };
    },
  }),

  defineEdit({
    name: 'add_placeholder', title: 'Add a b-roll placeholder', group: 'text',
    description: 'Mark a slot for footage you do not have yet: a labelled placeholder on the b-roll lane from `start` for `duration` seconds (default 2.5), also listed in the shot list. Replace it later by add_clip on the same range.',
    input: { label: z.string().min(1).max(200), start: Seconds, duration: z.number().min(0.04).max(600).optional(), lane: LaneRef.optional() },
    examples: [{ args: { label: 'B-roll: typing on laptop', start: 6.1, duration: 2.5 } }],
    plan: (doc, a) => {
      const lane = laneRef(doc, a.lane ?? 'broll', { unlocked: true });
      const start = frameUs(doc, a.start);
      const clip = newClip({ kind: 'placeholder', start, in: 0, out: us(a.duration ?? 2.5), name: a.label });
      return { ops: insertClipOps(doc, lane.id, clip, false), summary: `Placeholder "${a.label}"`, result: { clip: clip.id } };
    },
  }),

  defineEdit({
    name: 'generate_captions', title: 'Generate captions', group: 'text',
    description: `Make burned-in captions from the transcript (transcribe first), replacing existing ones. style: ${CAPTION_STYLES.map((s) => s.id).join(', ')}. maxWords and maxChars size each card; cards break at pauses and sentence ends and never cross a cut; position is the vertical center as a fraction of the frame height (default per style, inside the platform safe zone).`,
    input: { style: z.enum(CAPTION_STYLES.map((s) => s.id) as [string, ...string[]]).optional(), maxWords: z.number().int().min(1).max(12).optional(), maxChars: z.number().int().min(6).max(80).optional(), position: z.number().min(0.1).max(0.9).optional() },
    examples: [{ args: { style: 'word-pop', maxWords: 3 } }, { args: { style: 'boxed', position: 0.72 } }],
    plan: (doc, a) => {
      const words = timelineWords(doc);
      if (!words.length) throw new AgentError('NO_TRANSCRIPT', 'There is no transcript of the speech on the timeline yet.', 'Call transcribe first (it finds the speech clips by itself).');
      if (!laneOfKind(doc, 'captions')) throw new AgentError('LANE_NOT_FOUND', 'This project has no captions lane.', 'add_lane {"kind":"captions"}.');
      const ops = captionOps(doc, words, { ...DEFAULT_CAPTIONS, styleId: a.style ?? doc.settings.captionStyleId ?? DEFAULT_CAPTIONS.styleId, maxWords: a.maxWords ?? DEFAULT_CAPTIONS.maxWords, maxChars: a.maxChars ?? DEFAULT_CAPTIONS.maxChars, position: a.position });
      const n = ops.filter((o) => o.op === 'addClip').length;
      return { ops, summary: `${n} captions (${a.style ?? 'default style'})`, result: { captions: n } };
    },
  }),

  defineEdit({
    name: 'style_captions', title: 'Restyle all captions', group: 'text', idempotent: true,
    description: `Change the look of every caption at once, keeping their words and timing: apply a preset (${CAPTION_STYLES.map((s) => s.id).join(', ')}) and/or override any style field, and move them with position (fraction of frame height).`,
    input: { style: z.enum(CAPTION_STYLES.map((s) => s.id) as [string, ...string[]]).optional(), position: z.number().min(0.1).max(0.9).optional(), ...TextStyle },
    examples: [{ args: { style: 'karaoke' } }, { args: { highlightColor: '#ff4d6d', size: 80, position: 0.6 } }],
    plan: (doc, a) => {
      const lane = laneOfKind(doc, 'captions');
      const caps = (lane?.clips ?? []).filter((c) => c.kind === 'caption' && c.text);
      if (!caps.length) throw new AgentError('NO_CAPTIONS', 'There are no captions to restyle.', 'generate_captions makes them from the transcript.');
      const preset = a.style ? CAPTION_STYLES.find((s) => s.id === a.style)! : null;
      const W = doc.canvas.width, H = doc.canvas.height;
      const ops: Op[] = caps.map((c: Clip) => {
        let t: TextSpec = preset ? { ...preset.text, content: c.text!.content, words: c.text!.words } : { ...c.text! };
        t = applyStyle(t, a);
        const patch: Partial<Clip> = { text: t };
        if (a.position != null || preset) {
          const layout = captionLayout(preset ?? CAPTION_STYLES[0]!, H > W ? doc.settings.safeZone : 'none', W, H, a.position);
          patch.transform = { ...c.transform, y: { value: Math.round(layout.cy - H / 2) } };
          if (preset) t.maxWidth = a.maxWidth ?? layout.maxWidth;
        }
        return { op: 'updateClip' as const, id: c.id, patch };
      });
      if (a.style) ops.push({ op: 'setMeta', patch: { settings: { ...doc.settings, captionStyleId: a.style } } });
      return { ops, summary: `Restyle ${caps.length} captions${a.style ? ` as ${a.style}` : ''}` };
    },
  }),
];

export const captionEnd = (c: Clip) => sec(clipEnd(c));
