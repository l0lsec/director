import { LibraryDb, LibraryError, json, type Row } from '../db';

export interface VoiceProfile {
  id: string; brandId: string; name: string; description: string; rules: string[]; examples: string[]; banned: string[]; wpm: number; updated: string; deleted: boolean;
}
export interface Hook { id: string; brandId: string; text: string; tags: string[]; score: number | null; source: string; refId: string | null; created: string; used: number; deleted: boolean }
export interface ScriptVersion { id: string; scriptId: string; n: number; text: string; wpm: number; targetSec: number | null; note: string; created: string }
export interface Script { id: string; brandId: string; title: string; voiceId: string | null; refId: string | null; created: string; updated: string; deleted: boolean; current: ScriptVersion; versions: number }

const strs = (v: unknown): string[] => json<unknown[]>(v, []).map(String);
const toVoice = (r: Row): VoiceProfile => ({
  id: String(r.id), brandId: String(r.brand_id), name: String(r.name), description: String(r.description), rules: strs(r.rules), examples: strs(r.examples), banned: strs(r.banned),
  wpm: Number(r.wpm), updated: String(r.updated), deleted: r.deleted_at != null,
});
const toHook = (r: Row): Hook => ({
  id: String(r.id), brandId: String(r.brand_id), text: String(r.text), tags: strs(r.tags), score: r.score == null ? null : Number(r.score), source: String(r.source),
  refId: (r.ref_id as string) ?? null, created: String(r.created), used: Number(r.used), deleted: r.deleted_at != null,
});
const toVersion = (r: Row): ScriptVersion => ({ id: String(r.id), scriptId: String(r.script_id), n: Number(r.n), text: String(r.text), wpm: Number(r.wpm), targetSec: r.target_sec == null ? null : Number(r.target_sec), note: String(r.note), created: String(r.created) });

function cleanList(v: string[] | undefined, max: number, len: number): string[] | undefined {
  return v?.map((s) => s.trim()).filter(Boolean).slice(0, max).map((s) => s.slice(0, len));
}

/** Brand voice profiles, the hook bank and versioned scripts. Every call is scoped to one brand. */
export class Studio {
  private lib: LibraryDb;
  constructor(lib: LibraryDb) { this.lib = lib;}
  private brand(brandId: string): void {
    if (!this.lib.get('SELECT 1 FROM brands WHERE id = ?', brandId)) throw new LibraryError(`brand ${brandId} not found`, 'NOT_FOUND');
  }

  // Voice profiles
  createVoice(brandId: string, v: { name: string; description?: string; rules?: string[]; examples?: string[]; banned?: string[]; wpm?: number }): VoiceProfile {
    this.brand(brandId);
    if (!v.name.trim()) throw new LibraryError('voice name cannot be empty', 'INVALID');
    const wpm = v.wpm ?? 160;
    if (!Number.isInteger(wpm) || wpm < 60 || wpm > 320) throw new LibraryError('words per minute must be 60 to 320', 'INVALID');
    const id = this.lib.id('voice');
    this.lib.run('INSERT INTO voices (id, brand_id, name, description, rules, examples, banned, wpm, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, brandId, v.name.trim(), (v.description ?? '').slice(0, 4000), JSON.stringify(cleanList(v.rules, 40, 300) ?? []), JSON.stringify(cleanList(v.examples, 20, 4000) ?? []),
      JSON.stringify(cleanList(v.banned, 100, 60) ?? []), wpm, this.lib.stamp());
    return this.voice(brandId, id)!;
  }
  voice(brandId: string, id: string): VoiceProfile | null { const r = this.lib.get('SELECT * FROM voices WHERE id = ? AND brand_id = ?', id, brandId); return r ? toVoice(r) : null; }
  voices(brandId: string, includeDeleted = false): VoiceProfile[] {
    return this.lib.all(`SELECT * FROM voices WHERE brand_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY updated DESC, id`, brandId).map(toVoice);
  }
  updateVoice(brandId: string, id: string, patch: Partial<Pick<VoiceProfile, 'name' | 'description' | 'rules' | 'examples' | 'banned' | 'wpm'>>): VoiceProfile {
    const cur = this.voice(brandId, id);
    if (!cur) throw new LibraryError('voice not found in this brand', 'NOT_FOUND');
    const next = { ...cur, ...patch, rules: cleanList(patch.rules, 40, 300) ?? cur.rules, examples: cleanList(patch.examples, 20, 4000) ?? cur.examples, banned: cleanList(patch.banned, 100, 60) ?? cur.banned };
    if (!next.name.trim()) throw new LibraryError('voice name cannot be empty', 'INVALID');
    if (!Number.isInteger(next.wpm) || next.wpm < 60 || next.wpm > 320) throw new LibraryError('words per minute must be 60 to 320', 'INVALID');
    this.lib.run('UPDATE voices SET name = ?, description = ?, rules = ?, examples = ?, banned = ?, wpm = ?, updated = ? WHERE id = ? AND brand_id = ?',
      next.name.trim(), next.description, JSON.stringify(next.rules), JSON.stringify(next.examples), JSON.stringify(next.banned), next.wpm, this.lib.stamp(), id, brandId);
    return this.voice(brandId, id)!;
  }
  deleteVoice(brandId: string, id: string): boolean { return this.lib.run('UPDATE voices SET deleted_at = ? WHERE id = ? AND brand_id = ? AND deleted_at IS NULL', this.lib.stamp(), id, brandId).changes > 0; }
  restoreVoice(brandId: string, id: string): boolean { return this.lib.run('UPDATE voices SET deleted_at = NULL WHERE id = ? AND brand_id = ? AND deleted_at IS NOT NULL', id, brandId).changes > 0; }

  // Hook bank
  addHook(brandId: string, h: { text: string; tags?: string[]; score?: number | null; source?: string; refId?: string | null }): Hook {
    this.brand(brandId);
    const text = h.text.trim().replace(/\s+/g, ' ');
    if (!text || text.length > 400) throw new LibraryError('hook must be 1 to 400 characters', 'INVALID');
    const dup = this.lib.get('SELECT id FROM hooks WHERE brand_id = ? AND lower(text) = lower(?) AND deleted_at IS NULL', brandId, text);
    if (dup) return this.hook(brandId, String(dup.id))!;
    if (h.score != null && !(h.score >= 0 && h.score <= 10)) throw new LibraryError('hook score must be 0 to 10', 'INVALID');
    const id = this.lib.id('hook');
    this.lib.run('INSERT INTO hooks (id, brand_id, text, tags, score, source, ref_id, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id, brandId, text, JSON.stringify(cleanList(h.tags?.map((t) => t.toLowerCase()), 12, 40) ?? []), h.score ?? null, h.source ?? 'manual', h.refId ?? null, this.lib.stamp());
    return this.hook(brandId, id)!;
  }
  hook(brandId: string, id: string): Hook | null { const r = this.lib.get('SELECT * FROM hooks WHERE id = ? AND brand_id = ?', id, brandId); return r ? toHook(r) : null; }
  hooks(brandId: string, q: { tag?: string; q?: string; includeDeleted?: boolean } = {}): Hook[] {
    return this.lib.all(`SELECT * FROM hooks WHERE brand_id = ? ${q.includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY coalesce(score, -1) DESC, created DESC, id`, brandId)
      .map(toHook)
      .filter((h) => (!q.tag || h.tags.includes(q.tag.toLowerCase())) && (!q.q || h.text.toLowerCase().includes(q.q.toLowerCase())));
  }
  updateHook(brandId: string, id: string, patch: { text?: string; tags?: string[]; score?: number | null }): Hook {
    const cur = this.hook(brandId, id);
    if (!cur) throw new LibraryError('hook not found in this brand', 'NOT_FOUND');
    const text = (patch.text ?? cur.text).trim().replace(/\s+/g, ' ');
    if (!text || text.length > 400) throw new LibraryError('hook must be 1 to 400 characters', 'INVALID');
    const score = patch.score === undefined ? cur.score : patch.score;
    if (score != null && !(score >= 0 && score <= 10)) throw new LibraryError('hook score must be 0 to 10', 'INVALID');
    this.lib.run('UPDATE hooks SET text = ?, tags = ?, score = ? WHERE id = ? AND brand_id = ?', text, JSON.stringify(cleanList(patch.tags?.map((t) => t.toLowerCase()), 12, 40) ?? cur.tags), score, id, brandId);
    return this.hook(brandId, id)!;
  }
  markHookUsed(brandId: string, id: string): void { this.lib.run('UPDATE hooks SET used = used + 1 WHERE id = ? AND brand_id = ?', id, brandId); }
  deleteHook(brandId: string, id: string): boolean { return this.lib.run('UPDATE hooks SET deleted_at = ? WHERE id = ? AND brand_id = ? AND deleted_at IS NULL', this.lib.stamp(), id, brandId).changes > 0; }
  restoreHook(brandId: string, id: string): boolean { return this.lib.run('UPDATE hooks SET deleted_at = NULL WHERE id = ? AND brand_id = ? AND deleted_at IS NOT NULL', id, brandId).changes > 0; }

  // Scripts with an append-only version history
  createScript(brandId: string, s: { title: string; text: string; wpm: number; targetSec?: number | null; voiceId?: string | null; refId?: string | null; note?: string }): Script {
    this.brand(brandId);
    if (!s.title.trim()) throw new LibraryError('script title cannot be empty', 'INVALID');
    if (s.voiceId && !this.voice(brandId, s.voiceId)) throw new LibraryError('voice not found in this brand', 'NOT_FOUND');
    const id = this.lib.id('script');
    const now = this.lib.stamp();
    this.lib.tx(() => {
      this.lib.run('INSERT INTO scripts (id, brand_id, title, voice_id, ref_id, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)', id, brandId, s.title.trim(), s.voiceId ?? null, s.refId ?? null, now, now);
      this.insertVersion(id, 1, s.text, s.wpm, s.targetSec ?? null, s.note ?? 'created');
    });
    return this.script(brandId, id)!;
  }
  private insertVersion(scriptId: string, n: number, text: string, wpm: number, targetSec: number | null, note: string): void {
    if (text.length > 100_000) throw new LibraryError('script is too long', 'INVALID');
    if (!Number.isInteger(wpm) || wpm < 60 || wpm > 320) throw new LibraryError('words per minute must be 60 to 320', 'INVALID');
    this.lib.run('INSERT INTO script_versions (id, script_id, n, text, wpm, target_sec, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', this.lib.id('ver'), scriptId, n, text, wpm, targetSec, note.slice(0, 200), this.lib.stamp());
  }
  script(brandId: string, id: string): Script | null {
    const r = this.lib.get('SELECT * FROM scripts WHERE id = ? AND brand_id = ?', id, brandId);
    if (!r) return null;
    const cur = this.lib.get('SELECT * FROM script_versions WHERE script_id = ? ORDER BY n DESC LIMIT 1', id)!;
    const count = Number(this.lib.get('SELECT count(*) n FROM script_versions WHERE script_id = ?', id)!.n);
    return { id: String(r.id), brandId: String(r.brand_id), title: String(r.title), voiceId: (r.voice_id as string) ?? null, refId: (r.ref_id as string) ?? null, created: String(r.created), updated: String(r.updated), deleted: r.deleted_at != null, current: toVersion(cur), versions: count };
  }
  scripts(brandId: string, includeDeleted = false): Script[] {
    return this.lib.all(`SELECT id FROM scripts WHERE brand_id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'} ORDER BY updated DESC, id`, brandId).map((r) => this.script(brandId, String(r.id))!);
  }
  /** Save a new version (no-op when nothing changed). Old versions are never rewritten. */
  saveVersion(brandId: string, id: string, v: { text: string; wpm?: number; targetSec?: number | null; note?: string; title?: string }): Script {
    const s = this.script(brandId, id);
    if (!s) throw new LibraryError('script not found in this brand', 'NOT_FOUND');
    const wpm = v.wpm ?? s.current.wpm;
    const target = v.targetSec === undefined ? s.current.targetSec : v.targetSec;
    this.lib.tx(() => {
      if (v.text !== s.current.text || wpm !== s.current.wpm || target !== s.current.targetSec) this.insertVersion(id, s.current.n + 1, v.text, wpm, target, v.note ?? 'edited');
      this.lib.run('UPDATE scripts SET title = ?, updated = ? WHERE id = ?', (v.title ?? s.title).trim() || s.title, this.lib.stamp(), id);
    });
    return this.script(brandId, id)!;
  }
  versions(brandId: string, id: string): ScriptVersion[] {
    if (!this.script(brandId, id)) throw new LibraryError('script not found in this brand', 'NOT_FOUND');
    return this.lib.all('SELECT * FROM script_versions WHERE script_id = ? ORDER BY n', id).map(toVersion);
  }
  version(brandId: string, versionId: string): ScriptVersion | null {
    const r = this.lib.get('SELECT v.* FROM script_versions v JOIN scripts s ON s.id = v.script_id WHERE v.id = ? AND s.brand_id = ?', versionId, brandId);
    return r ? toVersion(r) : null;
  }
  /** Restoring an old version appends it as the newest version, so history stays linear. */
  restoreVersion(brandId: string, id: string, n: number): Script {
    const old = this.versions(brandId, id).find((v) => v.n === n);
    if (!old) throw new LibraryError(`version ${n} not found`, 'NOT_FOUND');
    const s = this.script(brandId, id)!;
    this.lib.tx(() => {
      this.insertVersion(id, s.current.n + 1, old.text, old.wpm, old.targetSec, `restored v${n}`);
      this.lib.run('UPDATE scripts SET updated = ? WHERE id = ?', this.lib.stamp(), id);
    });
    return this.script(brandId, id)!;
  }
  deleteScript(brandId: string, id: string): boolean { return this.lib.run('UPDATE scripts SET deleted_at = ? WHERE id = ? AND brand_id = ? AND deleted_at IS NULL', this.lib.stamp(), id, brandId).changes > 0; }
  restoreScript(brandId: string, id: string): boolean { return this.lib.run('UPDATE scripts SET deleted_at = NULL WHERE id = ? AND brand_id = ? AND deleted_at IS NOT NULL', id, brandId).changes > 0; }
}
