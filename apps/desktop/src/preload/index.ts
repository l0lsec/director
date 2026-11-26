import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

// The renderer talks to main only through this bridge. Payloads are validated in main.
const api = {
  invoke: (channel: string, payload?: unknown): Promise<unknown> => ipcRenderer.invoke('director:invoke', channel, payload),
  on: (event: string, listener: (data: unknown) => void): (() => void) => {
    const wrapped = (_e: IpcRendererEvent, data: unknown) => listener(data);
    ipcRenderer.on(`director:event:${event}`, wrapped);
    return () => ipcRenderer.removeListener(`director:event:${event}`, wrapped);
  },
  /** Absolute path of a dropped File (Electron removed File.path). */
  pathForFile: (f: File): string => webUtils.getPathForFile(f),
  platform: process.platform,
  versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
};

contextBridge.exposeInMainWorld('director', api);
export type DirectorBridge = typeof api;
