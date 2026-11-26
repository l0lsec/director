// Helpers for M6 checks: launch the app on a fresh library, call the library, replay recorded Claude responses.
import { writeFileSync, readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { launchApp, tmp, root } from './lib.mjs';

export const responses = () => JSON.parse(readFileSync(join(root, 'packages', 'ai', 'fixtures', 'responses.json'), 'utf8'));
export const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/**
 * Launch with a temporary userData (so the library starts empty), optional recorded Claude responses
 * (task -> response or list), and a request log. Returns the app, window and paths.
 */
export async function launchStudio({ replay = null, env = {}, tab = 'swipe' } = {}) {
  const id = Math.random().toString(16).slice(2);
  const userData = tmp('m6-userdata-' + id);
  const projects = tmp('m6-projects-' + id);
  const work = tmp('m6-work-' + id);
  const log = join(work, 'claude-requests.jsonl');
  writeFileSync(log, '');
  const extra = {};
  if (replay) { const p = join(work, 'replay.json'); writeFileSync(p, JSON.stringify(replay)); extra.DIRECTOR_CLAUDE_REPLAY = p; }
  const app = await launchApp({ env: { DIRECTOR_USER_DATA: userData, DIRECTOR_PROJECTS_DIR: projects, DIRECTOR_CLAUDE_LOG: log, DIRECTOR_SHOW: '1', DIRECTOR_MCP_PORT: '0', ...extra, ...env } });
  const win = await app.firstWindow();
  await win.waitForSelector(`[data-testid="tab-${tab}"]`);
  await win.click(`[data-testid="tab-${tab}"]`);
  await win.waitForFunction(() => !!globalThis.__directorLib, null, { timeout: 20_000 });
  return { app, win, userData, projects, work, log };
}

export async function call(win, channel, payload) {
  const r = await win.evaluate(({ channel, payload }) => window.director.invoke(channel, payload), { channel, payload });
  if (!r.ok) throw new Error(`${channel}: ${r.error.code} ${r.error.message}`);
  return r.value;
}
export const libCall = (win, method, ...args) => call(win, 'library:call', { method, args });

export function requestLog(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Copy files into a scratch folder (optionally under new names) to build import scenarios. */
export function stage(dir, entries) {
  mkdirSync(dir, { recursive: true });
  return entries.map(([src, name]) => { const p = join(dir, name); mkdirSync(join(p, '..'), { recursive: true }); copyFileSync(src, p); return p; });
}

/** Create and open a project in this app (Edit workspace), as launchEditor does. */
export async function openProject(win, preset = 'vertical-1080') {
  await win.evaluate(async (p) => {
    const r = await window.director.invoke('project:create', { name: 'M6 check', preset: p });
    await window.director.invoke('settings:set', { key: 'lastProjectDir', value: r.value.dir });
  }, preset);
  await win.click('[data-testid="tab-edit"]');
  await win.waitForFunction(() => !!globalThis.__directorProject?.().doc && !!globalThis.__directorLibrary, null, { timeout: 20_000 });
}

/**
 * A talking-head edit: optional speech on Voice with a ground-truth transcript, and muted camera clips
 * placed at `cameraCuts` boundaries so the picture changes exactly there. Times in microseconds.
 */
export async function speechEdit(win, { voicePath = null, cameraPath, words = null, durationUs, cameraCuts = [] }) {
  await win.evaluate(async ({ voicePath, cameraPath, words, durationUs, cameraCuts }) => {
    const imported = await globalThis.__directorLibrary.importPaths(voicePath ? [voicePath, cameraPath] : [cameraPath]);
    const voice = voicePath ? imported[0] : null;
    const cam = imported[imported.length - 1];
    const P = () => globalThis.__directorProject().doc;
    const laneId = (k) => P().lanes.find((l) => l.kind === k).id;
    if (voice) await globalThis.__directorEditCmd.addMediaToTimeline(P().media[voice.id], 0, laneId('voice'));
    const bounds = [0, ...cameraCuts, durationUs];
    for (let i = 0; i < bounds.length - 1; i++) {
      await globalThis.__directorEditCmd.addMediaToTimeline(P().media[cam.id], bounds[i], laneId('camera'));
      const c = P().lanes.find((l) => l.kind === 'camera').clips.find((x) => x.start === bounds[i]);
      globalThis.__directorProjectApply([{ op: 'updateClip', id: c.id, patch: { out: c.in + (bounds[i + 1] - bounds[i]), ...(c.audio ? { audio: { ...c.audio, muted: true } } : {}) } }], 'trim');
    }
    if (voice && words) globalThis.__directorProjectApply([{ op: 'setMeta', patch: { transcript: [{ mediaId: voice.id, language: 'en', words }] } }], 'transcript');
  }, { voicePath, cameraPath, words, durationUs, cameraCuts });
}

/** The speech fixture as a talking-head edit with the reference reel as a single 26.8 s camera clip. */
export async function directorProject(win, gt, fixture) {
  await openProject(win);
  const words = gt.speech.words.map((w) => ({ text: w.text, start: Math.round(w.start * 1e6), end: Math.round(w.end * 1e6) }));
  await speechEdit(win, { voicePath: fixture('speech.wav'), cameraPath: fixture('reference-reel.mp4'), words, durationUs: 26_800_000 });
  await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'director' }));
  await win.waitForSelector('[data-testid="director-panel"]');
}
export const docJson = (win) => win.evaluate(() => JSON.stringify(globalThis.__directorProject().doc));

/** Turn the MCP bridge on in the app and connect an MCP client to it (the client SDK the desktop app ships). */
export async function mcpConnect(win, { token, name = 'director-check' } = {}) {
  const st = await call(win, 'mcp:enable', { on: true });
  if (!st.running) throw new Error(`MCP bridge did not start: ${st.error}`);
  const { requireFromDesktop } = await import('./lib.mjs');
  const { Client } = requireFromDesktop('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = requireFromDesktop('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(st.url), { requestInit: { headers: { Authorization: `Bearer ${token ?? st.token}` } } });
  await client.connect(transport);
  return { client, status: st };
}
