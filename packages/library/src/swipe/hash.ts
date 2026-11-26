import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

export const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv']);

/** Full-content SHA-256, streamed so large files do not load into memory. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** Expand files and folders (recursively) into video file paths, sorted, without duplicates. */
export function expandPaths(paths: string[], maxDepth = 6): string[] {
  const out = new Set<string>();
  const walk = (p: string, depth: number) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) {
      if (depth > maxDepth) return;
      for (const name of readdirSync(p)) if (!name.startsWith('.')) walk(join(p, name), depth + 1);
    } else if (st.isFile() && VIDEO_EXT.has(extname(p).toLowerCase())) out.add(p);
  };
  for (const p of paths) walk(p, 0);
  return [...out].sort();
}
