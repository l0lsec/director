import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Library } from '../src';

let clock = 0;
const now = () => new Date(Date.UTC(2026, 10, 1) + (clock++) * 1000).toISOString();
let dir: string;
let lib: Library;
const file = (rel: string, content: string | Buffer) => { const p = join(dir, rel); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, content); return p; };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeEach(() => {
  clock = 0;
  dir = mkdtempSync(join(tmpdir(), 'director-lib-'));
  lib = new Library(join(dir, 'library.sqlite'), now);
});

describe('import', () => {
  it('adds each distinct file once, by content hash, across files and folders', async () => {
    const b = lib.brands.create('Main');
    const a = file('in/a.mp4', 'AAAA');
    file('in/copy-of-a.mov', 'AAAA');
    file('in/sub/b.mp4', 'BBBB');
    file('in/sub/notes.txt', 'not a video');
    file('in/.hidden.mp4', 'HIDDEN');
    const c = file('other/c.webm', 'CCCC');
    const r = await lib.swipe.importPaths(b.id, [join(dir, 'in'), a, c]);
    expect(r.added.map((x) => x.hash).sort()).toEqual([sha('AAAA'), sha('BBBB'), sha('CCCC')].sort());
    expect(r.duplicates.length).toBe(2); // copy-of-a and the explicit a
    expect(r.failed).toEqual([]);
    const again = await lib.swipe.importPaths(b.id, [join(dir, 'in'), c]);
    expect(again.added).toEqual([]);
    expect(again.duplicates.length).toBe(4);
    expect(lib.swipe.list(b.id).length).toBe(3);
  });
  it('restores a deleted reference instead of duplicating it, and reports bad paths', async () => {
    const b = lib.brands.create('Main');
    const a = file('a.mp4', 'AAAA');
    const [ref] = (await lib.swipe.importPaths(b.id, [a])).added;
    expect(lib.swipe.remove(b.id, ref!.id)).toBe(true);
    expect(lib.swipe.list(b.id)).toEqual([]);
    const moved = file('moved/a2.mp4', 'AAAA');
    const r = await lib.swipe.importPaths(b.id, [moved, join(dir, 'missing.mp4'), file('x.txt', 'x')]);
    expect(r.restored.map((x) => x.id)).toEqual([ref!.id]);
    expect(r.restored[0]!.path).toBe(moved);
    expect(r.failed.length).toBe(2);
    expect(lib.swipe.list(b.id).length).toBe(1);
  });
  it('stores probe info, source URL and platform', async () => {
    const b = lib.brands.create('Main');
    const p = file('r.mp4', 'R');
    const r = await lib.swipe.importPaths(b.id, [{ path: p, sourceUrl: 'https://www.instagram.com/reel/abc/' }], { probe: async () => ({ durationUs: 12_000_000, width: 1080, height: 1920 }), folder: 'Hooks' });
    expect(r.added[0]).toMatchObject({ durationUs: 12_000_000, width: 1080, height: 1920, platform: 'instagram', folder: 'Hooks', size: 1, title: 'r' });
  });
});

describe('metadata', () => {
  it('saves stats, tags, folders and kits, then sorts and filters', async () => {
    const b = lib.brands.create('Main');
    const refs = (await lib.swipe.importPaths(b.id, ['a', 'b', 'c', 'd'].map((n) => file(`${n}.mp4`, n)))).added;
    const [a, bb, c, d] = refs as [typeof refs[0], typeof refs[0], typeof refs[0], typeof refs[0]];
    lib.swipe.update(b.id, a.id, { title: 'Zebra', views: 1000, likes: 100, comments: 10, shares: 0, folder: ' Hooks / Questions ' });
    lib.swipe.update(b.id, bb.id, { title: 'apple', views: 5000, likes: 100, comments: 0, shares: 0, folder: 'Hooks' });
    lib.swipe.update(b.id, c.id, { title: 'Mango', views: 200, likes: 50, comments: 10, shares: 0, folder: 'Edits' });
    lib.swipe.setTags(b.id, a.id, ['#Hook', 'question', 'hook', ' ']);
    lib.swipe.setTags(b.id, c.id, ['broll']);
    const kit = lib.swipe.createKit(b.id, 'Launch kit');
    lib.swipe.update(b.id, c.id, { kitId: kit.id });
    lib.swipe.update(b.id, d.id, { kitId: kit.id });
    expect(lib.swipe.get(b.id, a.id)!.folder).toBe('Hooks/Questions');
    expect(lib.swipe.get(b.id, a.id)!.tags).toEqual(['hook', 'question']);
    expect(lib.swipe.get(b.id, a.id)!.engagement).toBeCloseTo(0.11, 10);
    expect(lib.swipe.list(b.id, { sort: 'views' }).map((r) => r.id)).toEqual([bb.id, a.id, c.id, d.id]);
    expect(lib.swipe.list(b.id, { sort: 'views', dir: 'asc' }).map((r) => r.id)).toEqual([c.id, a.id, bb.id, d.id]); // missing stats always last
    expect(lib.swipe.list(b.id, { sort: 'engagement' }).map((r) => r.id)).toEqual([c.id, a.id, bb.id, d.id]); // 0.3, 0.11, 0.02
    expect(lib.swipe.list(b.id, { sort: 'title' }).map((r) => r.title)).toEqual(['apple', 'd', 'Mango', 'Zebra']);
    expect(lib.swipe.list(b.id, { folder: 'Hooks' }).map((r) => r.id).sort()).toEqual([a.id, bb.id].sort());
    expect(lib.swipe.list(b.id, { folder: 'Hooks/Questions' }).map((r) => r.id)).toEqual([a.id]);
    expect(lib.swipe.list(b.id, { tag: 'HOOK' }).map((r) => r.id)).toEqual([a.id]);
    expect(lib.swipe.list(b.id, { kitId: kit.id }).map((r) => r.id).sort()).toEqual([c.id, d.id].sort());
    expect(lib.swipe.list(b.id, { kitId: null }).length).toBe(2);
    expect(lib.swipe.list(b.id, { q: 'broll' }).map((r) => r.id)).toEqual([c.id]);
    expect(lib.swipe.list(b.id, { q: '100%' })).toEqual([]); // LIKE wildcards are escaped
    expect(lib.swipe.tags(b.id)).toEqual([{ tag: 'broll', count: 1 }, { tag: 'hook', count: 1 }, { tag: 'question', count: 1 }]);
    expect(lib.swipe.folders(b.id)).toEqual([{ folder: 'Edits', count: 1 }, { folder: 'Hooks', count: 1 }, { folder: 'Hooks/Questions', count: 1 }]);
    expect(lib.swipe.kits(b.id)).toEqual([{ id: kit.id, name: 'Launch kit', count: 2 }]);
    expect(() => lib.swipe.update(b.id, a.id, { views: -1 })).toThrow(/at least 0/);
    expect(() => lib.swipe.update(b.id, a.id, { views: 1.5 })).toThrow(/whole number/);
    expect(() => lib.swipe.update(b.id, a.id, { title: '  ' })).toThrow(/empty/);
    lib.swipe.deleteKit(b.id, kit.id);
    expect(lib.swipe.get(b.id, c.id)!.kitId).toBeNull();
  });
  it('persists across reopen', async () => {
    const b = lib.brands.create('Main');
    const [r] = (await lib.swipe.importPaths(b.id, [file('a.mp4', 'a')])).added;
    lib.swipe.update(b.id, r!.id, { views: 42, notes: 'great pacing' });
    lib.swipe.setTags(b.id, r!.id, ['pacing']);
    const path = join(dir, 'library.sqlite');
    lib.close();
    const again = new Library(path);
    expect(again.db.version).toBe(1);
    expect(again.swipe.get(b.id, r!.id)).toMatchObject({ views: 42, notes: 'great pacing', tags: ['pacing'] });
    again.close();
  });
});

describe('brands', () => {
  it('scopes references, voices, hooks, scripts and caption presets with no cross-brand leakage', async () => {
    const one = lib.brands.create('Brand One');
    const two = lib.brands.create('Brand Two');
    expect(() => lib.brands.create('brand one')).toThrow(/already exists/);
    const same = file('shared.mp4', 'SAME');
    const r1 = (await lib.swipe.importPaths(one.id, [same])).added[0]!;
    const r2 = (await lib.swipe.importPaths(two.id, [same])).added[0]!; // same file is its own entry in each brand
    expect(r1.id).not.toBe(r2.id);
    lib.swipe.setTags(one.id, r1.id, ['secret']);
    const v1 = lib.studio.createVoice(one.id, { name: 'Punchy', rules: ['short sentences'] });
    const h1 = lib.studio.addHook(one.id, { text: 'Stop scrolling', tags: ['pattern'] });
    const s1 = lib.studio.createScript(one.id, { title: 'Launch', text: 'Hello', wpm: 160, voiceId: v1.id });
    const p1 = lib.brands.savePreset(one.id, 'Bold', { styleId: 'bold' });
    // Brand two sees none of brand one's rows.
    expect(lib.swipe.list(two.id).map((r) => r.id)).toEqual([r2.id]);
    expect(lib.swipe.tags(two.id)).toEqual([]);
    expect(lib.studio.voices(two.id)).toEqual([]);
    expect(lib.studio.hooks(two.id)).toEqual([]);
    expect(lib.studio.scripts(two.id)).toEqual([]);
    expect(lib.brands.presets(two.id)).toEqual([]);
    // And cannot reach them by id either.
    expect(lib.swipe.get(two.id, r1.id)).toBeNull();
    expect(() => lib.swipe.update(two.id, r1.id, { title: 'x' })).toThrow(/not found/);
    expect(lib.swipe.remove(two.id, r1.id)).toBe(false);
    expect(() => lib.swipe.setTags(two.id, r1.id, ['x'])).toThrow(/not found/);
    expect(lib.studio.voice(two.id, v1.id)).toBeNull();
    expect(lib.studio.hook(two.id, h1.id)).toBeNull();
    expect(lib.studio.deleteHook(two.id, h1.id)).toBe(false);
    expect(lib.studio.script(two.id, s1.id)).toBeNull();
    expect(lib.studio.version(two.id, s1.current.id)).toBeNull();
    expect(() => lib.studio.saveVersion(two.id, s1.id, { text: 'x' })).toThrow(/not found/);
    expect(() => lib.studio.createScript(two.id, { title: 'x', text: '', wpm: 160, voiceId: v1.id })).toThrow(/voice not found/);
    expect(lib.brands.deletePreset(two.id, p1.id)).toBe(false);
    expect(() => lib.brands.savePreset(two.id, 'Hijack', {}, p1.id)).toThrow(/not found/);
    const kit = lib.swipe.createKit(one.id, 'K');
    expect(() => lib.swipe.update(two.id, r2.id, { kitId: kit.id })).toThrow(/kit not found/);
    // Brand one is untouched.
    expect(lib.swipe.get(one.id, r1.id)!.tags).toEqual(['secret']);
    expect(lib.studio.hooks(one.id).length).toBe(1);
    expect(lib.brands.presets(one.id).length).toBe(1);
    expect(lib.brands.list().map((b) => b.name)).toEqual(['Brand One', 'Brand Two']);
    lib.brands.update(two.id, { archived: true });
    expect(lib.brands.list().map((b) => b.name)).toEqual(['Brand One']);
  });
});

describe('studio', () => {
  it('creates, edits, deletes and restores voices, hooks and script versions', () => {
    const b = lib.brands.create('Main');
    const v = lib.studio.createVoice(b.id, { name: 'Warm', description: 'Friendly coach', rules: ['say you', ' '], examples: ['Here is the thing.'], banned: ['synergy'], wpm: 170 });
    expect(v).toMatchObject({ name: 'Warm', rules: ['say you'], banned: ['synergy'], wpm: 170, deleted: false });
    const v2 = lib.studio.updateVoice(b.id, v.id, { wpm: 150, rules: ['say you', 'no jargon'] });
    expect(v2).toMatchObject({ wpm: 150, rules: ['say you', 'no jargon'], examples: ['Here is the thing.'] });
    expect(() => lib.studio.updateVoice(b.id, v.id, { wpm: 20 })).toThrow(/60 to 320/);
    expect(lib.studio.deleteVoice(b.id, v.id)).toBe(true);
    expect(lib.studio.voices(b.id)).toEqual([]);
    expect(lib.studio.restoreVoice(b.id, v.id)).toBe(true);
    expect(lib.studio.voices(b.id).map((x) => x.id)).toEqual([v.id]);

    const h = lib.studio.addHook(b.id, { text: '  Nobody   tells you this ', tags: ['Curiosity'], score: 8 });
    expect(h.text).toBe('Nobody tells you this');
    expect(lib.studio.addHook(b.id, { text: 'nobody tells you this' }).id).toBe(h.id); // case-insensitive dedupe
    lib.studio.addHook(b.id, { text: 'Low score', score: 3 });
    expect(lib.studio.hooks(b.id).map((x) => x.score)).toEqual([8, 3]);
    expect(lib.studio.updateHook(b.id, h.id, { score: 9.5, tags: ['curiosity', 'list'] })).toMatchObject({ score: 9.5, tags: ['curiosity', 'list'] });
    expect(() => lib.studio.updateHook(b.id, h.id, { score: 11 })).toThrow(/0 to 10/);
    expect(lib.studio.hooks(b.id, { tag: 'list' }).map((x) => x.id)).toEqual([h.id]);
    lib.studio.deleteHook(b.id, h.id);
    expect(lib.studio.hooks(b.id).length).toBe(1);
    lib.studio.restoreHook(b.id, h.id);
    expect(lib.studio.hooks(b.id).length).toBe(2);

    const s = lib.studio.createScript(b.id, { title: 'Ep 1', text: 'v1 text', wpm: 160, targetSec: 30, voiceId: v.id });
    expect(s.current.n).toBe(1);
    const s2 = lib.studio.saveVersion(b.id, s.id, { text: 'v2 text', note: 'tighter' });
    expect(s2.current).toMatchObject({ n: 2, text: 'v2 text', wpm: 160, targetSec: 30, note: 'tighter' });
    expect(lib.studio.saveVersion(b.id, s.id, { text: 'v2 text' }).versions).toBe(2); // unchanged: no new version
    const s3 = lib.studio.restoreVersion(b.id, s.id, 1);
    expect(s3.current).toMatchObject({ n: 3, text: 'v1 text', note: 'restored v1' });
    expect(lib.studio.versions(b.id, s.id).map((x) => x.text)).toEqual(['v1 text', 'v2 text', 'v1 text']);
    expect(lib.studio.version(b.id, s2.current.id)!.text).toBe('v2 text');
    expect(lib.studio.deleteScript(b.id, s.id)).toBe(true);
    expect(lib.studio.scripts(b.id)).toEqual([]);
    expect(lib.studio.restoreScript(b.id, s.id)).toBe(true);
    expect(lib.studio.scripts(b.id)[0]!.versions).toBe(3);
  });
  it('rolls back a failed transaction', () => {
    const b = lib.brands.create('Main');
    expect(() => lib.studio.createScript(b.id, { title: 'Bad', text: 'x', wpm: 9999 })).toThrow(/60 to 320/);
    expect(lib.studio.scripts(b.id, true)).toEqual([]);
  });
});

describe('usage', () => {
  it('sums cost by task for the month', () => {
    lib.usage.record({ task: 'director', model: 'claude-opus-5-5', input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, costUsd: 0.014, at: '2026-11-02T00:00:00.000Z' });
    lib.usage.record({ task: 'hooks', model: 'claude-opus-5-5', input: 100, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.0024, at: '2026-11-03T00:00:00.000Z' });
    lib.usage.record({ task: 'hooks', model: 'claude-opus-5-5', input: 100, output: 100, cacheRead: 0, cacheWrite: 0, costUsd: 0.0024, at: '2026-10-03T00:00:00.000Z' });
    const s = lib.usage.summary('2026-11-01T00:00:00.000Z');
    expect(s.calls).toBe(2);
    expect(s.costUsd).toBeCloseTo(0.0164, 10);
    expect(s.byTask.map((t) => t.task)).toEqual(['director', 'hooks']);
  });
});
