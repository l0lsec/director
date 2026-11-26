import { BrowserWindow, screen } from 'electron';
import { join } from 'node:path';
import { loadPage } from '../index';
import { getSetting, setSetting } from '../settings';

export type PrompterMode = 'overlay' | 'display' | 'glass';
let prompter: BrowserWindow | null = null;
let mode: PrompterMode = 'overlay';

export function getPrompterWindow(): BrowserWindow | null { return prompter && !prompter.isDestroyed() ? prompter : null; }

/** CGWindowID of the prompter, used to exclude it from screen recordings. */
export function prompterWindowId(): number | null {
  const w = getPrompterWindow();
  if (!w) return null;
  const m = /^window:(\d+):/.exec(w.getMediaSourceId());
  return m ? Number(m[1]) : null;
}

function defaultOverlayBounds(near: Electron.Rectangle | null): Electron.Rectangle {
  const display = near ? screen.getDisplayMatching(near) : screen.getPrimaryDisplay();
  const wa = display.workArea;
  const width = Math.round(wa.width * 0.42);
  const height = Math.round(wa.height * 0.24);
  return { x: Math.round(wa.x + (wa.width - width) / 2), y: wa.y, width, height };
}

export function openPrompter(opts: { mode: PrompterMode; displayId?: number; near?: Electron.Rectangle | null }): { windowId: number | null; mode: PrompterMode } {
  mode = opts.mode;
  const existing = getPrompterWindow();
  if (existing) existing.close();
  const displays = screen.getAllDisplays();
  const target = opts.displayId != null ? displays.find((d) => d.id === opts.displayId) : undefined;
  let bounds: Electron.Rectangle;
  if (mode === 'overlay') {
    bounds = getSetting<Electron.Rectangle | null>('prompter.overlayBounds', null) ?? defaultOverlayBounds(opts.near ?? null);
  } else {
    const d = target ?? displays.find((x) => x.id !== screen.getPrimaryDisplay().id) ?? screen.getPrimaryDisplay();
    bounds = d.bounds;
  }
  prompter = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: mode === 'overlay',
    backgroundColor: mode === 'overlay' ? '#00000000' : '#000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: mode === 'overlay',
    movable: true,
    minimizable: false,
    fullscreenable: mode !== 'overlay',
    title: 'Director Prompter',
    show: process.env.DIRECTOR_TEST !== '1' || process.env.DIRECTOR_SHOW === '1',
    webPreferences: { preload: join(__dirname, '../preload/index.cjs'), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  prompter.setAlwaysOnTop(true, 'screen-saver');
  prompter.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Keep the prompter out of other apps' screen captures too (Zoom, OBS, macOS screenshots that honor it).
  prompter.setContentProtection(process.env.DIRECTOR_PROMPTER_VISIBLE_TO_CAPTURE !== '1');
  if (mode !== 'overlay') prompter.setSimpleFullScreen(true);
  const save = () => { if (mode === 'overlay' && prompter && !prompter.isDestroyed()) setSetting('prompter.overlayBounds', prompter.getBounds()); };
  prompter.on('moved', save);
  prompter.on('resized', save);
  prompter.on('closed', () => { prompter = null; });
  void loadPage(prompter, 'prompter', `?mode=${mode}`);
  return { windowId: prompterWindowId(), mode };
}

export function closePrompter(): boolean {
  const w = getPrompterWindow();
  if (!w) return false;
  w.close();
  return true;
}

export function sendToPrompter(channel: string, payload: unknown): void {
  const w = getPrompterWindow();
  if (w) w.webContents.send(`director:event:${channel}`, payload);
}
