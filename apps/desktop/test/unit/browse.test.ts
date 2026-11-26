import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listDir, searchFiles, thumbnail, watchRoot, rootFor, BrowseError } from '../../src/main/files/browse';

const repo = join(__dirname, '../../../..');
const media = (n: string) => join(repo, 'fixtures/media', n);
const ffmpeg = (() => { try { return execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim(); } catch { return null; } })();

let root: string, outside: string, cache: string;
beforeAll(() => {
  // A content folder laid out the way people keep one: categories, nested folders, stray files, a symlink loop.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'director-browse-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'director-outside-')));
  cache = join(root, '..', `cache-${Date.now()}`);
  for (const d of ['B-Roll/Drone', 'B-Roll/City', 'Music', 'SFX', 'Images', 'Edit.fcpbundle', '.hidden']) mkdirSync(join(root, d), { recursive: true });
  copyFileSync(media('reference-reel.mp4'), join(root, 'B-Roll/Drone/coast 10.mp4'));
  copyFileSync(media('cuts-720p.mp4'), join(root, 'B-Roll/Drone/coast 2.mp4'));
  copyFileSync(media('tone-440.wav'), join(root, 'Music/bed.wav'));
  copyFileSync(media('click-120bpm.wav'), join(root, 'SFX/whoosh.wav'));
  copyFileSync(media('still.png'), join(root, 'Images/logo.png'));
  copyFileSync(media('tone-440.wav'), join(root, '.hidden/secret.wav'));
  writeFileSync(join(root, 'notes.txt'), 'shot list');
  writeFileSync(join(root, 'B-Roll/Drone/.DS_Store'), '');
  symlinkSync(root, join(root, 'B-Roll/loop'));
  copyFileSync(media('tone-440.wav'), join(outside, 'elsewhere.wav'));
});
afterAll(() => { for (const d of [root, outside, cache]) rmSync(d, { recursive: true, force: true }); });

describe('listing a folder', () => {
  it('shows folders first in Finder order, then media; hides dotfiles, packages and other files', () => {
    const l = listDir(root, [root]);
    expect(l.entries.map((e) => `${e.type}:${e.name}`)).toEqual(['dir:B-Roll', 'dir:Images', 'dir:Music', 'dir:SFX']);
    expect(l.skipped).toBe(2); // notes.txt and the Final Cut library; dotfiles are not counted
    const drone = listDir(join(root, 'B-Roll/Drone'), [root]);
    expect(drone.entries.map((e) => e.name)).toEqual(['coast 2.mp4', 'coast 10.mp4']);
    expect(drone.entries[0]).toMatchObject({ type: 'video', rel: 'B-Roll/Drone/coast 2.mp4' });
    expect(drone.entries[0]!.size).toBe(statSync(join(root, 'B-Roll/Drone/coast 2.mp4')).size);
  });

  it('refuses relative paths, missing folders, files, and anything outside the opened folders', () => {
    const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as BrowseError).code; } };
    expect(code(() => listDir('B-Roll', [root]))).toBe('NOT_ABSOLUTE');
    expect(code(() => listDir(join(root, 'nope'), [root]))).toBe('NOT_FOUND');
    expect(code(() => listDir(join(root, 'Music/bed.wav'), [root]))).toBe('NOT_A_FOLDER');
    expect(code(() => listDir(outside, [root]))).toBe('OUTSIDE_ROOTS');
    expect(code(() => listDir(join(root, '..'), [root]))).toBe('OUTSIDE_ROOTS');
    expect(code(() => rootFor(join(root, 'B-Roll/../../'), [root]))).toBe('OUTSIDE_ROOTS');
    // A symlink inside the folder that points back to it is still inside.
    expect(code(() => listDir(join(root, 'B-Roll/loop'), [root]))).toBe('ok');
    expect(listDir(outside, [root, outside]).entries.map((e) => e.name)).toEqual(['elsewhere.wav']);
  });
});

describe('searching below a folder', () => {
  it('matches every word against the path, filters by kind, skips hidden files and survives symlink loops', () => {
    expect(searchFiles(root, 'drone coast', [root]).results.map((e) => e.rel)).toEqual(['B-Roll/Drone/coast 2.mp4', 'B-Roll/Drone/coast 10.mp4']);
    expect(searchFiles(root, 'wav', [root]).results.map((e) => e.rel).sort()).toEqual(['Music/bed.wav', 'SFX/whoosh.wav']);
    expect(searchFiles(root, '', [root], { kinds: ['image'] }).results.map((e) => e.name)).toEqual(['logo.png']);
    expect(searchFiles(root, 'secret', [root]).results).toEqual([]);
    const all = searchFiles(root, '', [root]);
    expect(all.results.length).toBe(5);
    expect(all.truncated).toBe(false);
  });

  it('stops at the result and folder limits and says so', () => {
    const r = searchFiles(root, '', [root], { limit: 2 });
    expect(r.results.length).toBe(2);
    expect(r.truncated).toBe(true);
    expect(searchFiles(root, '', [root], { maxDirs: 1 }).truncated).toBe(true);
  });
});

describe('thumbnails', () => {
  it.skipIf(!ffmpeg)('makes one cached JPEG per video and image version, none for audio', async () => {
    const v = join(root, 'B-Roll/Drone/coast 10.mp4');
    const [a, b] = await Promise.all([thumbnail(v, cache, ffmpeg), thumbnail(v, cache, ffmpeg)]);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(existsSync(a!)).toBe(true);
    const jpeg = execFileSync('/usr/bin/file', ['-b', a!], { encoding: 'utf8' });
    expect(jpeg).toMatch(/JPEG/);
    expect(jpeg).toMatch(/240 ?x/);
    const img = await thumbnail(join(root, 'Images/logo.png'), cache, ffmpeg);
    expect(img && existsSync(img)).toBe(true);
    expect(await thumbnail(join(root, 'Music/bed.wav'), cache, ffmpeg)).toBeNull();
    expect(await thumbnail(join(root, 'missing.mp4'), cache, ffmpeg)).toBeNull();
  });
});

describe('watching', () => {
  it('reports the folder a new file lands in', async () => {
    const changed: string[][] = [];
    const stop = watchRoot(root, (d) => changed.push(d), 50);
    try {
      await new Promise((r) => setTimeout(r, 200));
      copyFileSync(media('tone-440.wav'), join(root, 'SFX/new hit.wav'));
      const t0 = Date.now();
      while (!changed.flat().includes(join(root, 'SFX')) && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
      expect(changed.flat()).toContain(join(root, 'SFX'));
    } finally { stop(); }
  });
});
