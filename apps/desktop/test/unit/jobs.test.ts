import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { runJob, jobEvents, ffmpegProgress, shutdownJobs, liveJobs } from '../../src/main/jobs/runner';
import { requireSidecar } from '../../src/main/jobs/sidecars';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('job runner', () => {
  it('reports monotonic progress from ffmpeg and completes', async () => {
    const seen: number[] = [];
    const onProgress = (p: { units: number; ratio: number | null }) => { seen.push(p.units); };
    jobEvents.on('progress', onProgress);
    const job = runJob({
      kind: 'test-encode', cmd: requireSidecar('ffmpeg'), total: 4_000_000, parseProgress: ffmpegProgress,
      args: ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-progress', 'pipe:1', '-f', 'null', '-'],
    });
    const res = await job.promise;
    jobEvents.off('progress', onProgress);
    expect(res.code).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('cancels within 500 ms and leaves no child process', async () => {
    const job = runJob({ kind: 'test-long', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=60', '-f', 'null', '-'] });
    const pid = job.child.pid!;
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    job.cancel();
    const res = await job.promise;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(res.cancelled).toBe(true);
    expect(alive(pid)).toBe(false);
  });

  it('a process ignoring SIGTERM is killed, and shutdown kills everything', async () => {
    const stubborn = runJob({ kind: 'stubborn', cmd: '/bin/sh', args: ['-c', 'trap "" TERM; while true; do sleep 0.05; done'] });
    const pid = stubborn.child.pid!;
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    stubborn.cancel();
    await stubborn.promise;
    expect(Date.now() - t0).toBeLessThan(500);
    expect(alive(pid)).toBe(false);
    const a = runJob({ kind: 'a', cmd: '/bin/sleep', args: ['30'] });
    const b = runJob({ kind: 'b', cmd: '/bin/sleep', args: ['30'] });
    expect(liveJobs().length).toBeGreaterThanOrEqual(2);
    shutdownJobs();
    await Promise.all([a.promise, b.promise]);
    expect(alive(a.child.pid!)).toBe(false);
    expect(alive(b.child.pid!)).toBe(false);
    const orphans = execSync(`pgrep -P ${process.pid} || true`).toString().trim();
    expect(orphans).toBe('');
  });
});
