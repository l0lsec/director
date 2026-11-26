import type { Take, TakeMarker } from '@director/engine';
import { invoke } from '../../../shell/bridge';

const MIME_CANDIDATES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'];

export function pickMime(): string {
  for (const m of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return m;
  return '';
}

export function bitrateFor(width: number, height: number, fps: number): number {
  const px = width * height * Math.max(24, fps);
  return Math.round(Math.min(60_000_000, Math.max(6_000_000, px * 0.2)));
}

export interface StartOptions {
  stream: MediaStream;
  title: string;
  projectDir?: string | null;
  projectId?: string;
  script?: Take['script'];
  devices: Take['devices'];
  screen?: { displayId?: number } | null;
  timesliceMs?: number;
}

/** Streams a MediaRecorder to disk in small fsynced chunks so a crash keeps the take. */
export class TakeRecorder {
  takeId = '';
  dir = '';
  cameraStartMs = 0;
  markers: TakeMarker[] = [];
  alignment: Array<{ wordIndex: number; t: number }> = [];
  private rec: MediaRecorder | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  private failed: string | null = null;
  private stopped: Promise<void> | null = null;

  get elapsedUs(): number { return this.cameraStartMs ? Math.max(0, Math.round((Date.now() - this.cameraStartMs) * 1000)) : 0; }
  get writtenBytes(): number { return this.bytes; }

  async start(o: StartOptions): Promise<void> {
    const mimeType = pickMime();
    const track = o.stream.getVideoTracks()[0];
    const s = track?.getSettings() ?? {};
    const vbps = bitrateFor(s.width ?? 1920, s.height ?? 1080, s.frameRate ?? 30);
    const begun = await invoke('take:begin', { title: o.title, projectDir: o.projectDir ?? undefined, projectId: o.projectId, script: o.script, devices: o.devices, mimeType, videoBitsPerSecond: vbps });
    this.takeId = begun.takeId;
    this.dir = begun.dir;
    const rec = new MediaRecorder(o.stream, { mimeType, videoBitsPerSecond: vbps, audioBitsPerSecond: 192_000 });
    this.rec = rec;
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      this.chain = this.chain.then(async () => {
        const buf = new Uint8Array(await e.data.arrayBuffer());
        this.bytes = await invoke('take:chunk', { takeId: this.takeId, stream: 'camera', data: buf });
      }).catch((err: Error) => { this.failed = err.message; });
    };
    const started = new Promise<void>((resolve) => { rec.onstart = () => resolve(); });
    this.stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
    try {
      rec.start(o.timesliceMs ?? 500);
    } catch (err) {
      // Nothing was captured: close the take as trashed so no empty take is left in the list.
      await invoke('take:end', { takeId: this.takeId, patch: { status: 'trashed', notes: `Recorder did not start: ${(err as Error).message}`.slice(0, 400) } }).catch(() => undefined);
      throw err;
    }
    await started;
    this.cameraStartMs = Date.now();
    if (o.screen) await invoke('screen:start', { takeId: this.takeId, displayId: o.screen.displayId, excludePrompter: true });
  }

  mark(kind: TakeMarker['kind'], label: string, extra: { line?: number; wordIndex?: number } = {}): TakeMarker {
    const m: TakeMarker = { t: this.elapsedUs, kind, label, ...extra };
    this.markers.push(m);
    return m;
  }

  align(wordIndex: number): void {
    const last = this.alignment[this.alignment.length - 1];
    if (!last || last.wordIndex !== wordIndex) this.alignment.push({ wordIndex, t: this.elapsedUs });
  }

  pause(): void { if (this.rec?.state === 'recording') { this.rec.pause(); this.mark('pause', 'Paused'); } }
  resume(): void { if (this.rec?.state === 'paused') { this.rec.resume(); this.mark('resume', 'Resumed'); } }

  audioOffsetUs = 0;

  async stop(): Promise<{ take: Take; dir: string }> {
    const durationUs = this.elapsedUs;
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    await this.stopped;
    await this.chain;
    if (this.failed) throw new Error(`Recording write failed: ${this.failed}`);
    return invoke('take:end', { takeId: this.takeId, patch: { durationUs, clock: { cameraStartMs: this.cameraStartMs, audioOffsetUs: this.audioOffsetUs }, markers: this.markers, alignment: this.alignment } });
  }
}
