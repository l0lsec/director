import { app } from 'electron';
import { existsSync, mkdirSync, statSync, rmSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';

export interface ModelInfo { id: string; file: string; dtw: string; sizeMB: number; label: string; url: string; sha256?: string }

/** whisper.cpp ggml models. The checksum is fetched from the model host's LFS listing when not pinned. */
export const MODELS: ModelInfo[] = [
  { id: 'small.en', file: 'ggml-small.en.bin', dtw: 'small.en', sizeMB: 466, label: 'Small (English, fast)', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin' },
  { id: 'base.en', file: 'ggml-base.en.bin', dtw: 'base.en', sizeMB: 142, label: 'Base (English, fastest)', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin' },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', dtw: 'large.v3.turbo', sizeMB: 1550, label: 'Large v3 Turbo (best, multilingual)', url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin' },
];

export function modelDirs(): string[] {
  const own = process.env.DIRECTOR_MODELS_DIR ?? join(process.env.DIRECTOR_USER_DATA ?? app.getPath('userData'), 'models');
  mkdirSync(own, { recursive: true });
  return [own, join(homedir(), '.cache', 'whisper'), '/opt/homebrew/share/whisper-cpp/models'];
}

export function findModel(id?: string): { info: ModelInfo; path: string } | null {
  const order = id ? MODELS.filter((m) => m.id === id) : [MODELS.find((m) => m.id === 'large-v3-turbo')!, MODELS.find((m) => m.id === 'small.en')!, MODELS.find((m) => m.id === 'base.en')!];
  for (const info of order) for (const d of modelDirs()) { const p = join(d, info.file); if (existsSync(p) && statSync(p).size > 1_000_000) return { info, path: p }; }
  return null;
}

export function listModels(): Array<ModelInfo & { path: string | null }> {
  return MODELS.map((m) => ({ ...m, path: modelDirs().map((d) => join(d, m.file)).find((p) => existsSync(p)) ?? null }));
}

export { sha256File, downloadVerified } from './download';

/** Expected SHA-256 for a model from the host's LFS metadata (the file listing API). */
export async function remoteSha256(info: ModelInfo): Promise<string> {
  if (info.sha256) return info.sha256;
  const api = 'https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main';
  const body = await new Promise<string>((resolve, reject) => {
    request(api, (res) => { let s = ''; res.setEncoding('utf8'); res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); res.on('error', reject); }).on('error', reject).end();
  });
  const list = JSON.parse(body) as Array<{ path: string; lfs?: { oid: string } }>;
  const entry = list.find((e) => e.path === info.file);
  if (!entry?.lfs?.oid) throw new Error(`no checksum published for ${info.file}`);
  return entry.lfs.oid;
}

export function cleanupPartials(): void {
  for (const d of modelDirs()) { try { for (const f of readdirSync(d)) if (f.endsWith('.partial') && statSync(join(d, f)).mtimeMs < Date.now() - 7 * 864e5) rmSync(join(d, f)); } catch { /* ignore */ } }
}
