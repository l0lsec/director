import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync, writeSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TakeSchema, type Take } from '@director/engine';

/** Takes live in <root>/<YYYY-MM-DD HHMM - title>/ with take.json and media files. */
export function takeFolderName(title: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const safe = title.replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || 'Take';
  return `${stamp} - ${safe}`;
}

interface Writer { fd: number; bytes: number; chunks: number }

/** An in-progress recording: append-only files fsynced per chunk so a crash keeps everything written. */
export class TakeRecording {
  readonly id = `take_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  readonly dir: string;
  readonly writers = new Map<string, Writer>();
  take: Take;

  constructor(root: string, init: { title: string; script?: Take['script']; devices: Take['devices']; mimeType: string; videoBitsPerSecond: number; projectId?: string; ext: string }) {
    this.dir = join(root, takeFolderName(init.title));
    mkdirSync(this.dir, { recursive: true });
    this.take = {
      schemaVersion: 1, id: this.id, title: init.title, createdAt: new Date().toISOString(), durationUs: 0,
      files: { camera: `camera.${init.ext}` }, devices: init.devices, clock: { cameraStartMs: 0 }, script: init.script,
      markers: [], alignment: [], recorder: { mimeType: init.mimeType, videoBitsPerSecond: init.videoBitsPerSecond, chunks: 0 },
      rating: 0, notes: '', status: 'recording', projectId: init.projectId,
    };
    this.writeJson();
  }

  append(stream: 'camera' | 'mic', data: Uint8Array): number {
    let w = this.writers.get(stream);
    if (!w) {
      const name = stream === 'camera' ? this.take.files.camera! : 'mic.pcm';
      w = { fd: openSync(join(this.dir, name), 'a'), bytes: 0, chunks: 0 };
      this.writers.set(stream, w);
    }
    writeSync(w.fd, data);
    fsyncSync(w.fd);
    w.bytes += data.byteLength;
    w.chunks++;
    if (stream === 'camera') this.take.recorder.chunks = w.chunks;
    return w.bytes;
  }

  writeJson(): void {
    const tmp = join(this.dir, `take.json.tmp`);
    writeFileSync(tmp, JSON.stringify(this.take, null, 1));
    renameSync(tmp, join(this.dir, 'take.json'));
  }

  finish(patch: Partial<Take>): Take {
    for (const w of this.writers.values()) closeSync(w.fd);
    this.writers.clear();
    this.take = TakeSchema.parse({ ...this.take, ...patch, status: 'ok' });
    this.writeJson();
    return this.take;
  }
}

export interface TakeEntry { take: Take; dir: string }

export function readTake(dir: string): TakeEntry | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'take.json'), 'utf8'));
    const parsed = TakeSchema.safeParse(raw);
    if (!parsed.success) return null;
    return { take: parsed.data, dir };
  } catch { return null; }
}

export function listTakes(root: string, { includeTrashed = false } = {}): TakeEntry[] {
  if (!existsSync(root)) return [];
  const out: TakeEntry[] = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const t = readTake(dir);
    if (t && (includeTrashed || t.take.status !== 'trashed')) out.push(t);
  }
  return out.sort((a, b) => b.take.createdAt.localeCompare(a.take.createdAt));
}

export function updateTake(dir: string, patch: Partial<Pick<Take, 'title' | 'rating' | 'notes' | 'status' | 'markers'>>): Take {
  const cur = readTake(dir);
  if (!cur) throw Object.assign(new Error('take not found'), { code: 'NOT_FOUND' });
  const next = TakeSchema.parse({ ...cur.take, ...patch });
  writeFileSync(join(dir, 'take.json.tmp'), JSON.stringify(next, null, 1));
  renameSync(join(dir, 'take.json.tmp'), join(dir, 'take.json'));
  return next;
}

/** Recover takes whose app crashed mid-recording: mark them ok with whatever was written. */
export function recoverInterrupted(root: string): number {
  let n = 0;
  for (const t of listTakes(root)) {
    if (t.take.status !== 'recording') continue;
    updateTake(t.dir, { status: 'ok', notes: `${t.take.notes}${t.take.notes ? '\n' : ''}Recovered after an interrupted recording.` });
    n++;
  }
  return n;
}

export function takeRootFor(projectDir: string | null, fallback: string): string {
  return projectDir ? join(projectDir, 'takes') : fallback;
}

export { basename, dirname };
