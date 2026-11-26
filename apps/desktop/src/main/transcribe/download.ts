import { createHash } from 'node:crypto';
import { createReadStream, existsSync, openSync, closeSync, writeSync, statSync, renameSync, rmSync } from 'node:fs';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

type Progress = (received: number, total: number | null) => void;

/**
 * Resumable download with checksum verification: bytes go to <dest>.partial (continuing with an HTTP
 * Range request when one exists), and the file is only renamed into place when its SHA-256 matches.
 */
export function downloadVerified(url: string, dest: string, sha256: string, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<string> {
  const partial = `${dest}.partial`;
  return new Promise((resolve, reject) => {
    const start = existsSync(partial) ? statSync(partial).size : 0;
    const get = (u: string, redirects: number) => {
      const req = (u.startsWith('https:') ? request : httpRequest)(u, { headers: start ? { Range: `bytes=${start}-` } : {} }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) { res.resume(); get(new URL(res.headers.location, u).toString(), redirects + 1); return; }
        if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); reject(new Error(`download failed: HTTP ${res.statusCode}`)); return; }
        const resumed = res.statusCode === 206;
        const fd = openSync(partial, resumed ? 'a' : 'w');
        let received = resumed ? start : 0;
        const len = Number(res.headers['content-length'] ?? NaN);
        const total = Number.isFinite(len) ? len + (resumed ? start : 0) : null;
        res.on('data', (chunk: Buffer) => { writeSync(fd, chunk); received += chunk.length; onProgress(received, total); });
        res.on('end', async () => {
          closeSync(fd);
          if (signal?.aborted) { reject(Object.assign(new Error('download cancelled'), { name: 'AbortError' })); return; }
          const got = await sha256File(partial);
          if (got !== sha256.toLowerCase()) { rmSync(partial, { force: true }); reject(Object.assign(new Error(`checksum mismatch: expected ${sha256.slice(0, 12)}, got ${got.slice(0, 12)}; the file was discarded`), { code: 'CHECKSUM' })); return; }
          renameSync(partial, dest);
          resolve(dest);
        });
        res.on('error', (e) => { closeSync(fd); reject(e); });
      });
      req.on('error', reject);
      signal?.addEventListener('abort', () => req.destroy(Object.assign(new Error('download cancelled'), { name: 'AbortError' })));
      req.end();
    };
    get(url, 0);
  });
}

