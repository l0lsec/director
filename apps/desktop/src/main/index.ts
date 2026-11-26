import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc/register';
import { shutdownJobs } from './jobs/runner';
import { closeAllSessions } from './store/handlers';
import { shutdownCapture } from './capture/handlers';
import { registerMediaScheme, handleMediaProtocol } from './media/protocol';
import { initMcp, stop as stopMcp } from './mcp/server';
import { closeLibrary } from './library/handlers';

const isTest = process.env.DIRECTOR_TEST === '1';

// Automated checks never touch the person's login Keychain: secrets use Chromium's in-memory mock keychain, so a
// rebuilt (newly signed) app under test does not make macOS ask for the Keychain password.
if (isTest) app.commandLine.appendSwitch('use-mock-keychain');

// A desktop recorder must be able to start audio processing without a click first.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Test and demo hooks: Chromium's fake capture devices fed from files.
if (process.env.DIRECTOR_FAKE_VIDEO || process.env.DIRECTOR_FAKE_AUDIO) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (process.env.DIRECTOR_FAKE_VIDEO) app.commandLine.appendSwitch('use-file-for-fake-video-capture', process.env.DIRECTOR_FAKE_VIDEO);
  if (process.env.DIRECTOR_FAKE_AUDIO) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.DIRECTOR_FAKE_AUDIO);
    app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess');
  }
}
if (process.env.DIRECTOR_USER_DATA) app.setPath('userData', process.env.DIRECTOR_USER_DATA);
registerMediaScheme();

export function rendererUrl(page: 'index' | 'prompter', query = ''): { url?: string; file?: string } {
  const dev = process.env.ELECTRON_RENDERER_URL;
  if (dev) return { url: `${dev}/${page}.html${query}` };
  return { file: join(__dirname, `../renderer/${page}.html`) };
}

export function loadPage(win: BrowserWindow, page: 'index' | 'prompter', query = ''): Promise<void> {
  const target = rendererUrl(page, query);
  if (target.url) return win.loadURL(target.url);
  return win.loadFile(target.file!, query ? { search: query.replace(/^\?/, '') } : undefined);
}

let studio: BrowserWindow | null = null;

function createStudioWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    title: 'Director',
    backgroundColor: '#0e1014',
    show: !isTest || process.env.DIRECTOR_SHOW === '1',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Startup timing for the performance budget: process start to the first painted window.
  win.once('ready-to-show', () => { if (process.env.DIRECTOR_STARTUP_LOG === '1') console.log(`DIRECTOR_READY ${Math.round(Date.now() - performance.timeOrigin)}`); });
  void loadPage(win, 'index');
  return win;
}

app.whenReady().then(() => {
  handleMediaProtocol();
  registerIpc();
  studio = createStudioWindow();
  void initMcp();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) studio = createStudioWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isTest) app.quit();
});

app.on('before-quit', () => {
  closeAllSessions();
  shutdownCapture();
  shutdownJobs();
  void stopMcp();
  closeLibrary();
});

export function getStudioWindow(): BrowserWindow | null {
  return studio;
}
