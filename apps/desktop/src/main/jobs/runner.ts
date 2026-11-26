import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export interface JobSpec {
  kind: string;
  cmd: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Total expected units (for example microseconds of media) so progress can be a ratio. */
  total?: number;
  /** Parses a stdout/stderr line into progress units, or null. */
  parseProgress?: (line: string) => number | null;
  /** Receives each stdout line (for JSON-lines protocols). */
  onLine?: (line: string) => void;
  input?: string | Buffer;
}

export interface JobResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; cancelled: boolean }

export interface Job {
  id: string;
  kind: string;
  promise: Promise<JobResult>;
  cancel: () => void;
  child: ChildProcess;
}

export const jobEvents = new EventEmitter();
const live = new Map<string, Job>();

const MAX_CAPTURE = 8 * 1024 * 1024;

export function runJob(spec: JobSpec): Job {
  const id = randomUUID();
  const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let cancelled = false;
  let lastProgress = 0;
  let killTimer: NodeJS.Timeout | null = null;

  const handleLines = (chunk: string, buffer: { rest: string }, isStdout: boolean) => {
    const text = buffer.rest + chunk;
    const lines = text.split(/\r?\n|\r/);
    buffer.rest = lines.pop() ?? '';
    for (const line of lines) {
      if (isStdout) spec.onLine?.(line);
      const units = spec.parseProgress?.(line);
      if (units != null && units >= lastProgress) {
        lastProgress = units;
        const ratio = spec.total ? Math.min(1, units / spec.total) : null;
        jobEvents.emit('progress', { id, kind: spec.kind, units, ratio });
      }
    }
  };
  const outBuf = { rest: '' };
  const errBuf = { rest: '' };
  child.stdout!.setEncoding('utf8');
  child.stderr!.setEncoding('utf8');
  child.stdout!.on('data', (c: string) => { if (stdout.length < MAX_CAPTURE) stdout += c; handleLines(c, outBuf, true); });
  child.stderr!.on('data', (c: string) => { if (stderr.length < MAX_CAPTURE) stderr += c; handleLines(c, errBuf, false); });
  if (spec.input != null) child.stdin!.end(spec.input); else child.stdin!.end();

  const promise = new Promise<JobResult>((resolve) => {
    child.on('error', (err) => {
      stderr += String(err);
    });
    child.on('close', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (outBuf.rest) spec.onLine?.(outBuf.rest);
      live.delete(id);
      const result = { code, signal, stdout, stderr, cancelled };
      jobEvents.emit('done', { id, kind: spec.kind, code, cancelled });
      resolve(result);
    });
  });

  const cancel = () => {
    if (child.exitCode != null || child.signalCode != null) return;
    cancelled = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => { if (child.exitCode == null) child.kill('SIGKILL'); }, 300);
  };
  const job: Job = { id, kind: spec.kind, promise, cancel, child };
  live.set(id, job);
  jobEvents.emit('start', { id, kind: spec.kind });
  return job;
}

export async function runJobOk(spec: JobSpec): Promise<JobResult> {
  const res = await runJob(spec).promise;
  if (res.cancelled) throw Object.assign(new Error(`${spec.kind} cancelled`), { code: 'CANCELLED' });
  if (res.code !== 0) throw Object.assign(new Error(`${spec.kind} failed (exit ${res.code}): ${res.stderr.slice(-600)}`), { code: 'JOB_FAILED' });
  return res;
}

export function cancelJob(id: string): boolean {
  const job = live.get(id);
  if (!job) return false;
  job.cancel();
  return true;
}

export function liveJobs(): Job[] { return [...live.values()]; }

export function shutdownJobs(): void {
  for (const job of live.values()) {
    job.cancel();
    job.child.kill('SIGKILL');
  }
}

/** ffmpeg `-progress pipe:1` emits out_time_us=<n>; returns microseconds. */
export function ffmpegProgress(line: string): number | null {
  const m = /^out_time_us=(\d+)/.exec(line) ?? /^out_time_ms=(\d+)/.exec(line);
  return m ? Number(m[1]) : null;
}
