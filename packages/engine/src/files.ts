import type { LaneKind, MediaRef } from './schema/project';

/** Helpers for browsing a content folder: what a file is, and which lane its category folder suggests. */

export type FileKind = 'video' | 'audio' | 'image';
export type MediaRole = NonNullable<MediaRef['role']>;

const VIDEO = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv']);
const AUDIO = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic']);

/** Extensions Director can import, without the dot. */
export const BROWSABLE_EXTENSIONS: readonly string[] = [...VIDEO, ...AUDIO, ...IMAGE];

/** The media kind of a file name, or null when Director cannot import it. */
export function fileKindOf(name: string): FileKind | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return VIDEO.has(ext) ? 'video' : AUDIO.has(ext) ? 'audio' : IMAGE.has(ext) ? 'image' : null;
}

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
/** Finder-like order: "Take 2" before "Take 10", case ignored. */
export const naturalCompare = (a: string, b: string): number => natural.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

/** The lane each media role lands on (matches the app's natural lane for imported media). */
export const LANE_FOR_ROLE: Record<MediaRole, LaneKind> = {
  camera: 'camera', screen: 'screen', mic: 'voice', broll: 'broll', music: 'music', sfx: 'sfx', image: 'broll', other: 'broll',
};

/** Roles that make sense for each kind, in the order a menu offers them. */
export const ROLES_FOR_KIND: Record<FileKind, MediaRole[]> = {
  video: ['camera', 'screen', 'broll'],
  audio: ['mic', 'music', 'sfx'],
  image: ['image'],
};

// Category words, checked against folder names nearest-first, then the file name.
// Each rule applies only to the kinds it lists, so a "Music" folder never sends a video to an audio lane.
const RULES: Array<{ role: MediaRole; kinds: FileKind[]; re: RegExp }> = [
  { role: 'sfx', kinds: ['audio'], re: /\b(sfx|sound ?effects?|fx|foley|whoosh(es)?|swoosh(es)?|risers?|impacts?|hits?|stingers?|dings?|pops?)\b/ },
  { role: 'music', kinds: ['audio'], re: /\b(music|songs?|beats?|soundtracks?|bgm|instrumentals?|loops?|tracks?)\b/ },
  { role: 'mic', kinds: ['audio'], re: /\b(voice ?overs?|vo|voices?|narrations?|dialog(ue)?|mics?|microphone|podcast ?audio|audio ?recordings?)\b/ },
  { role: 'screen', kinds: ['video'], re: /\b(screen ?(recordings?|captures?|casts?|shares?)?|screencasts?|demos?|walkthroughs?|tutorials?)\b/ },
  { role: 'camera', kinds: ['video'], re: /\b(a ?roll|cameras?|cams?|talking ?heads?|interviews?|takes?|raw|main ?footage|selfie)\b/ },
  { role: 'broll', kinds: ['video'], re: /\b(b ?roll|stock|cut ?aways?|inserts?|drone|overlays?|establishing|scenery|lifestyle)\b/ },
];

const words = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[_\-.+]+/g, ' ').replace(/([a-z])([0-9])/g, '$1 $2');

export interface RoleGuess { role: MediaRole; lane: LaneKind; from: string }

/**
 * Guess a role (and so a lane) from where a file sits in the user's content folder.
 * relPath is the path below the opened folder, e.g. "Audio/SFX/whoosh 01.wav". Images are always "image" (B-roll lane).
 * Returns null when nothing in the path names a category; the app then uses its usual default for the kind.
 */
export function guessRole(relPath: string, kind: FileKind): RoleGuess | null {
  const parts = relPath.split('/').filter(Boolean);
  const file = parts.pop() ?? '';
  if (kind === 'image') return { role: 'image', lane: 'broll', from: 'image' };
  for (const part of [...parts.reverse(), file]) {
    const w = words(part);
    for (const r of RULES) if (r.kinds.includes(kind) && r.re.test(w)) return { role: r.role, lane: LANE_FOR_ROLE[r.role], from: part };
  }
  return null;
}
