import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type SidecarName = 'ffmpeg' | 'ffprobe' | 'whisper-cli' | 'director-native' | 'yt-dlp';

const ENV: Record<SidecarName, string> = {
  ffmpeg: 'DIRECTOR_FFMPEG',
  ffprobe: 'DIRECTOR_FFPROBE',
  'whisper-cli': 'DIRECTOR_WHISPER',
  'director-native': 'DIRECTOR_NATIVE',
  'yt-dlp': 'DIRECTOR_YTDLP',
};

const cache = new Map<SidecarName, string | null>();

/**
 * Directories searched in order: env override, bundled resources, repo native build, the self-contained sidecars
 * made by scripts/release/bundle-sidecars.mjs (so a development build keeps working when Homebrew upgrades a library
 * under its binaries), Homebrew, PATH.
 */
export function searchDirs(): string[] {
  const dirs: string[] = [];
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) dirs.push(join(resources, 'bin'));
  if (process.env.DIRECTOR_REPO_ROOT) dirs.push(join(process.env.DIRECTOR_REPO_ROOT, 'native/DirectorKit/.build/release'));
  dirs.push(join(__dirname, '../../../../native/DirectorKit/.build/release'));
  dirs.push(join(process.cwd(), 'native/DirectorKit/.build/release'));
  if (process.env.DIRECTOR_REPO_ROOT) dirs.push(join(process.env.DIRECTOR_REPO_ROOT, 'apps/desktop/build/sidecars/bin'));
  dirs.push(join(__dirname, '../../build/sidecars/bin'));
  if (!process.env.DIRECTOR_BUNDLED_ONLY) {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin');
    for (const d of (process.env.PATH ?? '').split(delimiter)) if (d) dirs.push(d);
  }
  return dirs;
}

export function resolveSidecar(name: SidecarName): string | null {
  if (cache.has(name)) return cache.get(name)!;
  const override = process.env[ENV[name]];
  let found: string | null = override && existsSync(override) ? override : null;
  if (!found) {
    for (const dir of searchDirs()) {
      const p = join(dir, name);
      if (existsSync(p)) { found = p; break; }
    }
  }
  cache.set(name, found);
  return found;
}

export function requireSidecar(name: SidecarName): string {
  const p = resolveSidecar(name);
  if (!p) throw Object.assign(new Error(`${name} was not found. Install it or set ${ENV[name]}.`), { code: 'SIDECAR_MISSING' });
  return p;
}

export function clearSidecarCache(): void { cache.clear(); }
