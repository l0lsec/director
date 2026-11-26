import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerified } from '../../src/main/transcribe/download';

const body = randomBytes(3 * 1024 * 1024);
const sha = createHash('sha256').update(body).digest('hex');

function server(opts: { dropAfter?: number } = {}) {
  let requests: Array<{ range?: string }> = [];
  const s = createServer((req, res) => {
    requests.push({ range: req.headers.range });
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = m ? Number(m[1]) : 0;
    const chunk = body.subarray(start);
    res.writeHead(m ? 206 : 200, { 'Content-Length': String(chunk.length), ...(m ? { 'Content-Range': `bytes ${start}-${body.length - 1}/${body.length}` } : {}) });
    if (opts.dropAfter != null && !m) { res.write(chunk.subarray(0, opts.dropAfter)); setTimeout(() => res.destroy(), 50); return; }
    res.end(chunk);
  });
  return new Promise<{ url: string; close: () => void; requests: () => typeof requests }>((resolve) => s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as { port: number }).port;
    resolve({ url: `http://127.0.0.1:${port}/model.bin`, close: () => s.close(), requests: () => requests });
  }));
}

describe('model download', () => {
  it('verifies the checksum before installing', async () => {
    const srv = await server();
    const dest = join(mkdtempSync(join(tmpdir(), 'dl-')), 'model.bin');
    await downloadVerified(srv.url, dest, sha);
    expect(readFileSync(dest).equals(body)).toBe(true);
    srv.close();
  });

  it('resumes after an interrupted transfer with a Range request', async () => {
    const srv = await server({ dropAfter: 1024 * 1024 });
    const dest = join(mkdtempSync(join(tmpdir(), 'dl-')), 'model.bin');
    await expect(downloadVerified(srv.url, dest, sha)).rejects.toThrow();
    expect(existsSync(dest)).toBe(false);
    const partial = statSync(`${dest}.partial`).size;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(body.length);
    await downloadVerified(srv.url, dest, sha);
    expect(readFileSync(dest).equals(body)).toBe(true);
    expect(srv.requests().some((r) => r.range === `bytes=${partial}-`)).toBe(true);
    srv.close();
  });

  it('rejects a corrupted file and leaves nothing installed', async () => {
    const srv = await server();
    const dest = join(mkdtempSync(join(tmpdir(), 'dl-')), 'model.bin');
    await expect(downloadVerified(srv.url, dest, 'f'.repeat(64))).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.partial`)).toBe(false);
    srv.close();
  });
});
