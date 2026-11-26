import { CURRENT_SCHEMA_VERSION, ProjectSchema, type Project } from '../schema/project';
import { constantSpeed, defaultAudio, defaultTransform, newProject } from '../model';

/**
 * v0 was the prototype format: seconds as floats, fps as a number, "tracks" with type video|audio.
 * Each migration takes the previous version's raw JSON and returns the next version's raw JSON.
 */
type Raw = Record<string, any>;

function v0to1(raw: Raw): Raw {
  const fps = typeof raw.fps === 'number' ? { num: Math.round(raw.fps * 1000), den: 1000 } : { num: 30, den: 1 };
  if (Number.isInteger(raw.fps)) { fps.num = raw.fps; fps.den = 1; }
  const base = newProject({ name: raw.name ?? 'Untitled', id: raw.id, canvas: { width: raw.width ?? 1080, height: raw.height ?? 1920, fps }, now: raw.created ?? new Date(0).toISOString() });
  const us = (s: number) => Math.round(s * 1_000_000);
  const media: Raw = {};
  let n = 0;
  const camera = base.lanes.find((l) => l.kind === 'camera')!;
  const voice = base.lanes.find((l) => l.kind === 'voice')!;
  for (const track of raw.tracks ?? []) {
    const lane = track.type === 'audio' ? voice : camera;
    for (const c of track.clips ?? []) {
      const mediaId = `m${(n++).toString(36)}`;
      media[mediaId] = {
        id: mediaId, path: c.src, hash: '', name: String(c.src).split('/').pop(), kind: track.type === 'audio' ? 'audio' : 'video',
        durationUs: us(c.sourceDuration ?? c.out), hasAudio: true, hasVideo: track.type !== 'audio', addedAt: base.createdAt, missing: true,
      };
      lane.clips.push({
        id: `c${n.toString(36)}`, kind: 'media', mediaId, start: us(c.start), in: us(c.in ?? 0), out: us(c.out),
        speed: constantSpeed(c.speed ?? 1), reverse: false, transform: defaultTransform(), blend: 'normal', effects: [],
        audio: { ...defaultAudio(), gainDb: { value: c.volumeDb ?? 0 } }, enabled: true,
      });
    }
  }
  return { ...base, media, updatedAt: raw.modified ?? base.updatedAt };
}

const MIGRATIONS: Record<number, (raw: Raw) => Raw> = { 0: v0to1 };

export function detectVersion(raw: Raw): number {
  if (typeof raw.schemaVersion === 'number') return raw.schemaVersion;
  if (raw.version === 0 || Array.isArray(raw.tracks)) return 0;
  throw new Error('Unrecognized project format');
}

export function migrateProject(raw: unknown): { project: Project; from: number } {
  if (!raw || typeof raw !== 'object') throw new Error('Project file is not an object');
  let cur = raw as Raw;
  const from = detectVersion(cur);
  if (from > CURRENT_SCHEMA_VERSION) throw new Error(`Project was saved by a newer Director (schema ${from}); update the app.`);
  for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`No migration from schema ${v}`);
    cur = step(cur);
    cur.schemaVersion = v + 1;
  }
  return { project: ProjectSchema.parse(cur), from };
}
