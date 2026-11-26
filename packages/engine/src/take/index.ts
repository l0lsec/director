import { z } from 'zod';

export const TakeMarkerSchema = z.object({
  t: z.number().int().nonnegative(),
  kind: z.enum(['retake', 'cue', 'note', 'good', 'bad', 'pause', 'resume']),
  label: z.string().max(400),
  line: z.number().int().nonnegative().optional(),
  wordIndex: z.number().int().nonnegative().optional(),
});

export const TakeSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(64),
  title: z.string().max(200),
  createdAt: z.string().max(40),
  durationUs: z.number().int().nonnegative(),
  files: z.object({ camera: z.string().max(400).optional(), screen: z.string().max(400).optional(), mic: z.string().max(400).optional() }),
  devices: z.object({
    camera: z.object({ id: z.string(), label: z.string(), width: z.number().int(), height: z.number().int(), fps: z.number() }).optional(),
    mic: z.object({ id: z.string(), label: z.string() }).optional(),
    screen: z.object({ displayId: z.number().int(), excludedWindows: z.array(z.number().int()) }).optional(),
  }),
  /** Wall-clock start of each stream (unix ms) and offsets relative to the camera start (microseconds). */
  clock: z.object({ cameraStartMs: z.number(), screenStartMs: z.number().optional(), screenOffsetUs: z.number().int().optional(), audioOffsetUs: z.number().int().optional() }),
  script: z.object({ text: z.string().max(200_000), scriptId: z.string().max(64).optional(), version: z.number().int().nonnegative().optional() }).optional(),
  markers: z.array(TakeMarkerSchema),
  /** Voice-follow confirmations: script word index reached at time t (microseconds from camera start). */
  alignment: z.array(z.object({ wordIndex: z.number().int().nonnegative(), t: z.number().int().nonnegative() })),
  recorder: z.object({ mimeType: z.string().max(120), videoBitsPerSecond: z.number().int().nonnegative(), chunks: z.number().int().nonnegative() }),
  rating: z.number().int().min(0).max(5),
  notes: z.string().max(4000),
  status: z.enum(['recording', 'ok', 'trashed']),
  projectId: z.string().max(64).optional(),
});

export type Take = z.infer<typeof TakeSchema>;
export type TakeMarker = z.infer<typeof TakeMarkerSchema>;
