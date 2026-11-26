import { describe, it, expect } from 'vitest';
import { fileKindOf, guessRole, naturalCompare, BROWSABLE_EXTENSIONS, LANE_FOR_ROLE, ROLES_FOR_KIND } from '../src';

describe('file kinds', () => {
  it('knows every importable extension, in any case, and nothing else', () => {
    expect(fileKindOf('Take 1.MOV')).toBe('video');
    expect(fileKindOf('clip.mkv')).toBe('video');
    expect(fileKindOf('song.Mp3')).toBe('audio');
    expect(fileKindOf('logo.HEIC')).toBe('image');
    for (const n of ['notes.txt', 'project.prproj', 'README', '.mov', 'archive.zip', 'cut.fcpxml']) expect(fileKindOf(n)).toBeNull();
    expect(BROWSABLE_EXTENSIONS.length).toBe(17);
    expect(BROWSABLE_EXTENSIONS.every((e) => fileKindOf(`a.${e}`) !== null)).toBe(true);
  });

  it('sorts like Finder: numbers by value, case ignored', () => {
    expect(['Take 10.mov', 'take 2.mov', 'Take 1.mov', 'B-roll', 'a-roll'].sort(naturalCompare)).toEqual(['a-roll', 'B-roll', 'Take 1.mov', 'take 2.mov', 'Take 10.mov']);
  });
});

describe('lane guess from category folders', () => {
  const g = (p: string, k: 'video' | 'audio' | 'image') => guessRole(p, k);

  it('reads the common category names', () => {
    expect(g('Audio/SFX/whoosh 01.wav', 'audio')).toEqual({ role: 'sfx', lane: 'sfx', from: 'SFX' });
    expect(g('Sound Effects/ding.mp3', 'audio')?.lane).toBe('sfx');
    expect(g('Music/Upbeat/track_04.mp3', 'audio')?.lane).toBe('music');
    expect(g('Voiceover/intro.m4a', 'audio')?.lane).toBe('voice');
    expect(g('VO/ep 3.wav', 'audio')?.lane).toBe('voice');
    expect(g('Screen Recordings/setup.mov', 'video')?.lane).toBe('screen');
    expect(g('A-Roll/2026-11-02.mov', 'video')?.lane).toBe('camera');
    expect(g('Talking Heads/take 3.mp4', 'video')?.lane).toBe('camera');
    expect(g('B-Roll/Drone/coast.mp4', 'video')).toEqual({ role: 'broll', lane: 'broll', from: 'Drone' });
    expect(g('B-Roll/Cities/tokyo.mp4', 'video')?.from).toBe('B-Roll');
    expect(g('B_roll/city.mov', 'video')?.lane).toBe('broll');
    expect(g('Stock/office.mp4', 'video')?.lane).toBe('broll');
  });

  it('the nearest folder wins, then the file name', () => {
    expect(g('Music/Sound Effects/riser.wav', 'audio')?.role).toBe('sfx');
    expect(g('Audio/whoosh_big.wav', 'audio')?.from).toBe('whoosh_big.wav');
    expect(g('Projects/Client A/screencast01.mov', 'video')?.role).toBe('screen');
  });

  it('never sends a file to a lane of the wrong kind, and says nothing when no folder names a category', () => {
    expect(g('Music/music video.mp4', 'video')).toBeNull();
    expect(g('B-Roll/ambience.wav', 'audio')).toBeNull();
    expect(g('2026/November/IMG_0042.mov', 'video')).toBeNull();
    expect(g('clip.mov', 'video')).toBeNull();
    expect(g('Music/cover.png', 'image')).toEqual({ role: 'image', lane: 'broll', from: 'image' });
  });

  it('every role offered for a kind maps to a lane', () => {
    for (const roles of Object.values(ROLES_FOR_KIND)) for (const r of roles) expect(LANE_FOR_ROLE[r]).toBeTruthy();
  });
});
