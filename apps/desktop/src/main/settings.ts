import { app, safeStorage } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** Small JSON settings store in userData. Secrets go through safeStorage (macOS Keychain-backed). */
let cache: Record<string, unknown> | null = null;
const file = () => join(process.env.DIRECTOR_USER_DATA ?? app.getPath('userData'), 'settings.json');

function load(): Record<string, unknown> {
  if (cache) return cache;
  try { cache = existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}; } catch { cache = {}; }
  return cache!;
}

export function getSetting<T>(key: string, fallback: T): T {
  const v = load()[key];
  return (v === undefined ? fallback : v) as T;
}

export function setSetting(key: string, value: unknown): void {
  const s = load();
  if (value === undefined || value === null) delete s[key]; else s[key] = value;
  mkdirSync(dirname(file()), { recursive: true });
  writeFileSync(file(), JSON.stringify(s, null, 2));
}

export function setSecret(key: string, value: string | null): void {
  if (!value) { setSetting(`secret:${key}`, undefined); return; }
  if (!safeStorage.isEncryptionAvailable()) throw Object.assign(new Error('Secure storage is not available'), { code: 'NO_KEYCHAIN' });
  setSetting(`secret:${key}`, safeStorage.encryptString(value).toString('base64'));
}

export function getSecret(key: string): string | null {
  const enc = getSetting<string | null>(`secret:${key}`, null);
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}

export function hasSecret(key: string): boolean { return !!getSetting<string | null>(`secret:${key}`, null); }
