import { z } from 'zod';

export const CURRENT_SCHEMA_VERSION = 1;

export const FpsSchema = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });
const Micros = z.number().int();
const Id = z.string().min(1).max(64);

export const EaseSchema = z.enum(['linear', 'ease', 'easeIn', 'easeOut', 'hold']);
export const KeyframeSchema = z.object({ t: Micros.nonnegative(), v: z.number(), ease: EaseSchema });
/** A numeric property that may be animated. Keyframe times are relative to the clip start. */
export const AnimatableSchema = z.object({ value: z.number(), keyframes: z.array(KeyframeSchema).optional() });

export const TransformSchema = z.object({
  x: AnimatableSchema,
  y: AnimatableSchema,
  scale: AnimatableSchema,
  rotation: AnimatableSchema,
  opacity: AnimatableSchema,
  crop: z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1), right: z.number().min(0).max(1), bottom: z.number().min(0).max(1) }),
  flipH: z.boolean(),
  flipV: z.boolean(),
});

export const SpeedSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('constant'), rate: z.number().min(0.05).max(20), preservePitch: z.boolean() }),
  z.object({
    kind: z.literal('ramp'),
    /** Speed control points over normalized clip output time (0..1). */
    points: z.array(z.object({ at: z.number().min(0).max(1), rate: z.number().min(0.05).max(20) })).min(2),
    preservePitch: z.boolean(),
  }),
]);

export const EffectSchema = z.object({
  id: Id,
  type: z.string().min(1).max(64),
  enabled: z.boolean(),
  params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), AnimatableSchema])),
});

export const AudioSchema = z.object({
  gainDb: AnimatableSchema,
  pan: z.number().min(-1).max(1),
  fadeIn: Micros.nonnegative(),
  fadeOut: Micros.nonnegative(),
  muted: z.boolean(),
  duckable: z.boolean(),
});

export const WordSchema = z.object({ text: z.string(), start: Micros, end: Micros, emphasis: z.boolean().optional() });

export const TextSchema = z.object({
  content: z.string().max(5000),
  styleId: z.string().max(64).optional(),
  font: z.string().max(120),
  size: z.number().positive().max(2000),
  weight: z.number().int().min(100).max(1000),
  color: z.string().max(32),
  align: z.enum(['left', 'center', 'right']),
  stroke: z.object({ color: z.string(), width: z.number().min(0).max(100) }).optional(),
  shadow: z.object({ color: z.string(), blur: z.number().min(0), x: z.number(), y: z.number() }).optional(),
  box: z.object({ color: z.string(), padding: z.number().min(0), radius: z.number().min(0) }).optional(),
  lineHeight: z.number().positive().max(4),
  maxWidth: z.number().positive().max(1),
  animationIn: z.string().max(64).optional(),
  animationOut: z.string().max(64).optional(),
  animationDuration: Micros.nonnegative().optional(),
  /** Word timing for captions (relative to clip start). */
  words: z.array(WordSchema).optional(),
  highlightColor: z.string().max(32).optional(),
  uppercase: z.boolean().optional(),
});

export const ClipKindSchema = z.enum(['media', 'text', 'caption', 'shape', 'adjustment', 'placeholder']);

export const TransitionSchema = z.object({ type: z.string().min(1).max(64), duration: Micros.positive() });

export const ClipSchema = z.object({
  id: Id,
  kind: ClipKindSchema,
  name: z.string().max(200).optional(),
  mediaId: Id.optional(),
  /** Timeline position. */
  start: Micros.nonnegative(),
  /** Source range for media clips; for generated clips in = 0 and out = duration. */
  in: Micros.nonnegative(),
  out: Micros.positive(),
  speed: SpeedSchema,
  reverse: z.boolean(),
  freezeAt: Micros.nonnegative().optional(),
  transform: TransformSchema,
  /** How media fills the canvas before the transform: cover crops, contain letterboxes. Default cover. */
  fit: z.enum(['cover', 'contain', 'stretch']).optional(),
  blend: z.enum(['normal', 'screen', 'multiply', 'overlay', 'add']),
  effects: z.array(EffectSchema),
  audio: AudioSchema.optional(),
  text: TextSchema.optional(),
  shape: z.object({ type: z.enum(['rect', 'ellipse']), color: z.string(), radius: z.number().min(0) }).optional(),
  transitionIn: TransitionSchema.optional(),
  linkGroup: Id.optional(),
  enabled: z.boolean(),
  color: z.string().max(32).optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export const LaneKindSchema = z.enum(['graphics', 'titles', 'captions', 'broll', 'screen', 'camera', 'voice', 'music', 'sfx']);

export const LaneSchema = z.object({
  id: Id,
  kind: LaneKindSchema,
  name: z.string().max(100),
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  solo: z.boolean(),
  clips: z.array(ClipSchema),
});

export const MediaRefSchema = z.object({
  id: Id,
  path: z.string().min(1).max(4096),
  hash: z.string().max(128),
  name: z.string().max(400),
  kind: z.enum(['video', 'audio', 'image']),
  durationUs: Micros.nonnegative(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  fps: FpsSchema.optional(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  sampleRate: z.number().int().positive().optional(),
  channels: z.number().int().positive().optional(),
  codec: z.string().max(64).optional(),
  rotation: z.number().int().optional(),
  proxyPath: z.string().max(4096).optional(),
  missing: z.boolean().optional(),
  tags: z.array(z.string().max(64)).optional(),
  addedAt: z.string().max(40),
  takeId: Id.optional(),
  role: z.enum(['camera', 'screen', 'mic', 'broll', 'music', 'sfx', 'image', 'other']).optional(),
});

export const MarkerSchema = z.object({
  id: Id,
  t: Micros.nonnegative(),
  duration: Micros.nonnegative().optional(),
  kind: z.enum(['note', 'retake', 'cue', 'chapter', 'beat', 'good', 'bad']),
  label: z.string().max(400),
  color: z.string().max(32).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const CanvasSchema = z.object({
  width: z.number().int().min(16).max(8192),
  height: z.number().int().min(16).max(8192),
  fps: FpsSchema,
  background: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('color'), color: z.string().max(32) }),
    z.object({ kind: z.literal('blur'), amount: z.number().min(0).max(1) }),
  ]),
  sampleRate: z.number().int().positive(),
});

export const ProjectSchema = z.object({
  schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
  id: Id,
  name: z.string().min(1).max(200),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  canvas: CanvasSchema,
  brandId: Id.optional(),
  media: z.record(z.string(), MediaRefSchema),
  lanes: z.array(LaneSchema),
  markers: z.array(MarkerSchema),
  scriptRef: z.object({ scriptId: Id, version: z.number().int().nonnegative() }).optional(),
  scriptText: z.string().max(200_000).optional(),
  transcript: z
    .object({ mediaId: Id, language: z.string().max(16), words: z.array(WordSchema.extend({ p: z.number().min(0).max(1).optional() })) })
    .array()
    .optional(),
  settings: z.object({ snapping: z.boolean(), rippleByDefault: z.boolean(), captionStyleId: z.string().max(64).optional(), safeZone: z.enum(['none', 'reels', 'tiktok', 'shorts']) }),
});

export type Ease = z.infer<typeof EaseSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type Animatable = z.infer<typeof AnimatableSchema>;
export type Transform = z.infer<typeof TransformSchema>;
export type Speed = z.infer<typeof SpeedSchema>;
export type Effect = z.infer<typeof EffectSchema>;
export type ClipAudio = z.infer<typeof AudioSchema>;
export type Word = z.infer<typeof WordSchema>;
export type TextSpec = z.infer<typeof TextSchema>;
export type ClipKind = z.infer<typeof ClipKindSchema>;
export type Clip = z.infer<typeof ClipSchema>;
export type LaneKind = z.infer<typeof LaneKindSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type MediaRef = z.infer<typeof MediaRefSchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Canvas = z.infer<typeof CanvasSchema>;
export type Project = z.infer<typeof ProjectSchema>;

export const LANE_ORDER: LaneKind[] = ['graphics', 'titles', 'captions', 'broll', 'screen', 'camera', 'voice', 'music', 'sfx'];
export const LANE_LABEL: Record<LaneKind, string> = {
  graphics: 'Graphics', titles: 'Titles', captions: 'Captions', broll: 'B-roll', screen: 'Screen',
  camera: 'Camera', voice: 'Voice', music: 'Music', sfx: 'SFX',
};
export const AUDIO_LANES: ReadonlySet<LaneKind> = new Set(['voice', 'music', 'sfx']);
