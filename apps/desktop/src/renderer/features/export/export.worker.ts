/// <reference lib="webworker" />
import { exportProject, type ExportSpec, type MixedAudio } from '@director/media';
import type { Project } from '@director/engine';

// Runs the frame-by-frame render and encode off the UI thread. File writes go back to the page,
// which forwards them to the main process; each write is acknowledged so memory stays bounded.
let seq = 0;
const acks = new Map<number, () => void>();
let abort: AbortController | null = null;

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as { type: string; doc?: Project; spec?: ExportSpec; audio?: MixedAudio | null; ack?: number };
  if (msg.type === 'ack' && msg.ack != null) { acks.get(msg.ack)?.(); acks.delete(msg.ack); return; }
  if (msg.type === 'cancel') { abort?.abort(); return; }
  if (msg.type !== 'start' || !msg.doc || !msg.spec) return;
  abort = new AbortController();
  try {
    const res = await exportProject(msg.doc, msg.spec, msg.audio ?? null, {
      signal: abort.signal,
      write: (position, data) => new Promise<void>((resolve) => {
        const id = ++seq;
        acks.set(id, resolve);
        const copy = data.slice();
        (self as unknown as Worker).postMessage({ type: 'write', id, position, data: copy }, [copy.buffer]);
      }),
      progress: (ratio, frame, frames) => (self as unknown as Worker).postMessage({ type: 'progress', ratio, frame, frames }),
    });
    (self as unknown as Worker).postMessage({ type: 'done', result: res });
  } catch (err) {
    const e2 = err as Error;
    (self as unknown as Worker).postMessage({ type: 'error', name: e2.name, message: e2.message });
  }
};
