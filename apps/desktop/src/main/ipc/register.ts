import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { channels, type EventName, type EventPayload } from './contract';
import { dispatch, type HandlerMap } from './dispatch';
import { jobEvents, cancelJob } from '../jobs/runner';
import { probeMedia } from '../jobs/probe';
import { resolveSidecar, type SidecarName } from '../jobs/sidecars';
import { nativeDevices, nativeVersion } from '../jobs/native';
import { featureHandlers } from './features';

export function broadcast<E extends EventName>(event: E, payload: EventPayload<E>): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`director:event:${event}`, payload);
}

export const coreHandlers: HandlerMap<typeof channels> = {
  'app:info': () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData'),
    repoRoot: process.env.DIRECTOR_REPO_ROOT ?? null,
    sidecars: Object.fromEntries((['ffmpeg', 'ffprobe', 'whisper-cli', 'director-native', 'yt-dlp'] as SidecarName[]).map((n) => [n, resolveSidecar(n)])),
  }),
  'media:probe': ({ path }) => probeMedia(path),
  'job:cancel': ({ id }) => cancelJob(id),
  'dialog:open': async (opts) => {
    const props: Array<'openFile' | 'openDirectory' | 'multiSelections'> = [opts.directory ? 'openDirectory' : 'openFile'];
    if (opts.multi) props.push('multiSelections');
    const res = await dialog.showOpenDialog({ title: opts.title, properties: props, filters: opts.filters });
    return res.canceled ? [] : res.filePaths;
  },
  'dialog:save': async (opts) => {
    const res = await dialog.showSaveDialog({ title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
    return res.canceled || !res.filePath ? null : res.filePath;
  },
  'native:version': () => nativeVersion(),
  'native:devices': () => nativeDevices(),
  'shell:reveal': ({ path }) => { shell.showItemInFolder(path); return true; },
};

export function registerIpc(): void {
  const handlers = { ...coreHandlers, ...featureHandlers() } as HandlerMap<typeof channels>;
  ipcMain.handle('director:invoke', (event, channel: unknown, payload: unknown) =>
    dispatch(channels, handlers, channel, payload, { senderId: event.sender.id }),
  );
  jobEvents.on('start', (p) => broadcast('job:start', p));
  jobEvents.on('progress', (p) => broadcast('job:progress', p));
  jobEvents.on('done', (p) => broadcast('job:done', p));
}
