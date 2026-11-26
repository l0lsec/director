import { app, BrowserWindow, globalShortcut } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { join, dirname } from 'node:path';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { TakeRecording, listTakes, readTake, updateTake, recoverInterrupted } from '../takes/takeStore';
import { requireSidecar } from '../jobs/sidecars';
import { openPrompter, closePrompter, sendToPrompter, prompterWindowId, getPrompterWindow, type PrompterMode } from '../windows/prompter';
import { getSetting, setSetting } from '../settings';
import type { Take } from '@director/engine';

const recordings = new Map<string, TakeRecording>();
const screens = new Map<string, { proc: ChildProcessWithoutNullStreams; startMs: number | null; done: Promise<{ ok: boolean; error?: string }> }>();
let listener: ChildProcessWithoutNullStreams | null = null;

function broadcast(event: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`director:event:${event}`, payload);
}

export function defaultTakesRoot(): string {
  const dir = process.env.DIRECTOR_TAKES_DIR ?? join(app.getPath('videos'), 'Director Takes');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rootFor(projectDir?: string | null): string {
  if (projectDir) { const d = join(projectDir, 'takes'); mkdirSync(d, { recursive: true }); return d; }
  return defaultTakesRoot();
}

function lines(proc: ChildProcessWithoutNullStreams, onLine: (obj: Record<string, unknown>) => void): void {
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d: string) => {
    buf += d;
    const ls = buf.split('\n');
    buf = ls.pop()!;
    for (const l of ls) { if (!l.trim()) continue; try { onLine(JSON.parse(l)); } catch { /* ignore noise */ } }
  });
}

const HOTKEYS = ['Space', 'Up', 'Down', 'R', 'M', 'G', 'B', 'Escape'];

export function armHotkeys(on: boolean): string[] {
  for (const k of HOTKEYS) if (globalShortcut.isRegistered(k)) globalShortcut.unregister(k);
  if (!on) return [];
  const ok: string[] = [];
  for (const k of HOTKEYS) {
    if (globalShortcut.register(k, () => broadcast('hotkey', { key: k, source: 'global' }))) ok.push(k);
  }
  return ok;
}

export const captureHandlers = {
  'take:begin': (i: { title: string; projectDir?: string; projectId?: string; script?: Take['script']; devices: Take['devices']; mimeType: string; videoBitsPerSecond: number }) => {
    const ext = i.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const rec = new TakeRecording(rootFor(i.projectDir), { title: i.title, script: i.script, devices: i.devices, mimeType: i.mimeType, videoBitsPerSecond: i.videoBitsPerSecond, projectId: i.projectId, ext });
    recordings.set(rec.id, rec);
    return { takeId: rec.id, dir: rec.dir, camera: join(rec.dir, rec.take.files.camera!) };
  },
  'take:chunk': (i: { takeId: string; stream: 'camera' | 'mic'; data: Uint8Array }) => {
    const rec = recordings.get(i.takeId);
    if (!rec) throw Object.assign(new Error('no such recording'), { code: 'NOT_FOUND' });
    return rec.append(i.stream, i.data);
  },
  'take:end': async (i: { takeId: string; patch: Partial<Take> }) => {
    const rec = recordings.get(i.takeId);
    if (!rec) throw Object.assign(new Error('no such recording'), { code: 'NOT_FOUND' });
    const scr = screens.get(i.takeId);
    let patch = { ...i.patch };
    if (scr) {
      const res = await stopScreen(i.takeId);
      if (res.ok && scr.startMs != null) {
        patch = { ...patch, files: { ...rec.take.files, ...patch.files, screen: 'screen.mov' }, clock: { ...rec.take.clock, ...patch.clock, screenStartMs: scr.startMs, screenOffsetUs: Math.round((scr.startMs - (patch.clock?.cameraStartMs ?? rec.take.clock.cameraStartMs)) * 1000) } };
      }
    }
    const take = rec.finish(patch);
    recordings.delete(i.takeId);
    return { take, dir: rec.dir };
  },
  'take:list': (i: { projectDir?: string; includeTrashed?: boolean }) => {
    const root = rootFor(i.projectDir);
    recoverInterrupted(root);
    return listTakes(root, { includeTrashed: i.includeTrashed });
  },
  'take:get': (i: { dir: string }) => readTake(i.dir),
  'take:update': (i: { dir: string; patch: Partial<Pick<Take, 'title' | 'rating' | 'notes' | 'status' | 'markers'>> }) => updateTake(i.dir, i.patch),
  'screen:sources': async () => {
    const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn(requireSidecar('director-native'), ['screen-sources']);
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', (code) => resolve({ code, out }));
    });
    const items = res.out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const err = items.find((x) => x.error);
    if (err) throw Object.assign(new Error(String(err.error)), { code: 'SCREEN_PERMISSION' });
    return items;
  },
  'screen:start': (i: { takeId: string; displayId?: number; excludePrompter?: boolean; fps?: number }) => {
    const rec = recordings.get(i.takeId);
    if (!rec) throw Object.assign(new Error('no such recording'), { code: 'NOT_FOUND' });
    const args = ['screen-record', '--out', join(rec.dir, 'screen.mov'), '--fps', String(i.fps ?? 30)];
    if (i.displayId != null) args.push('--display', String(i.displayId));
    const pid = prompterWindowId();
    if (i.excludePrompter !== false && pid != null) args.push('--exclude-window', String(pid));
    const proc = spawn(requireSidecar('director-native'), args);
    const entry = { proc, startMs: null as number | null, done: null as unknown as Promise<{ ok: boolean; error?: string }> };
    let error: string | undefined;
    lines(proc, (o) => {
      if (o.event === 'started') entry.startMs = Number(o.t);
      if (o.error) error = String(o.error);
      broadcast('screen:event', { takeId: i.takeId, ...o });
    });
    entry.done = new Promise((resolve) => proc.on('close', (code) => resolve({ ok: code === 0 && !error, error })));
    screens.set(i.takeId, entry);
    return { excludedWindow: pid };
  },
  'follow:start': () => {
    if (listener) listener.kill('SIGKILL');
    listener = spawn(requireSidecar('director-native'), ['listen', '--engine', 'dictation', '--stdin']);
    const me = listener;
    lines(me, (o) => broadcast('follow:event', { ...o, recvMs: Date.now() }));
    me.on('close', () => { if (listener === me) listener = null; broadcast('follow:event', { type: 'closed' }); });
    me.stdin.on('error', () => { /* listener exited */ });
    return true;
  },
  'follow:audio': (i: { data: Uint8Array }) => {
    if (!listener || listener.stdin.destroyed) return false;
    listener.stdin.write(Buffer.from(i.data.buffer, i.data.byteOffset, i.data.byteLength));
    return true;
  },
  'follow:stop': () => {
    if (!listener) return false;
    listener.stdin.end();
    const p = listener;
    setTimeout(() => { if (!p.killed && p.exitCode == null) p.kill('SIGKILL'); }, 3000);
    return true;
  },
  'prompter:open': (i: { mode: PrompterMode; displayId?: number }) => {
    const studio = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Director');
    return openPrompter({ mode: i.mode, displayId: i.displayId, near: studio?.getBounds() ?? null });
  },
  'prompter:close': () => closePrompter(),
  'prompter:update': (i: { state: unknown }) => { sendToPrompter('prompter:state', i.state); return !!getPrompterWindow(); },
  'prompter:command': (i: { command: string; value?: number }) => { broadcast('prompter:command', i); return true; },
  'prompter:info': () => ({ open: !!getPrompterWindow(), windowId: prompterWindowId(), bounds: getPrompterWindow()?.getBounds() ?? null }),
  'hotkeys:arm': (i: { on: boolean }) => armHotkeys(i.on),
  'settings:get': (i: { key: string }) => getSetting<unknown>(i.key, null),
  'settings:set': (i: { key: string; value: unknown }) => { setSetting(i.key, i.value); return true; },
  'takes:root': (i: { projectDir?: string }) => (i.projectDir ? join(i.projectDir, 'takes') : defaultTakesRoot()),
  'file:exists': (i: { path: string }) => existsSync(i.path),
  'file:writeText': (i: { path: string; text: string }) => { writeFileSync(i.path, i.text, 'utf8'); return true; },
  'file:writeImage': (i: { path: string; data: Uint8Array }) => { mkdirSync(dirname(i.path), { recursive: true }); writeFileSync(i.path, i.data); return true; },
};

export async function stopScreen(takeId: string): Promise<{ ok: boolean; error?: string }> {
  const s = screens.get(takeId);
  if (!s) return { ok: false, error: 'not recording' };
  if (!s.proc.stdin.destroyed) s.proc.stdin.write('stop\n');
  const timer = setTimeout(() => s.proc.kill('SIGKILL'), 8000);
  const res = await s.done;
  clearTimeout(timer);
  screens.delete(takeId);
  return res;
}

export function shutdownCapture(): void {
  armHotkeys(false);
  for (const s of screens.values()) { try { s.proc.stdin.write('stop\n'); } catch { /* exiting */ } }
  if (listener) listener.kill('SIGKILL');
}
