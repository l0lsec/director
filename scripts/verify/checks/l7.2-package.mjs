import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { assert, sh, tmp, ensurePackaged, asarFiles } from '../lib.mjs';

// The packaged app, copied out of the repo like an install, launched on an empty profile (fresh HOME
// and user data, Homebrew off PATH) the way a new macOS account would first open it.
export default async function () {
  const built = ensurePackaged();
  const files = asarFiles(join(built, 'Contents', 'Resources', 'app.asar'));
  assert(files.includes('out/main/index.js') && files.includes('package.json'), 'app.asar is missing the app');
  assert(!files.some((f) => f.includes('node_modules')), 'app.asar ships node_modules');
  const plist = sh('plutil', ['-convert', 'json', '-o', '-', join(built, 'Contents', 'Info.plist')]).stdout;
  const info = JSON.parse(plist);
  for (const k of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) assert(info[k], `Info.plist lacks ${k}`);
  assert(info.CFBundleIdentifier === 'app.director.desktop' && info.CFBundleName === 'Director', `bundle ${info.CFBundleIdentifier}`);
  const verify = sh('codesign', ['--verify', '--deep', '--strict', built], { allowFail: true });
  assert(verify.status === 0, `signature does not verify: ${verify.stderr}`);
  // "Install": copy with ditto (as Finder does) to a folder outside the repo.
  const apps = tmp('l7.2-Applications');
  const installed = join(apps, 'Director.app');
  sh('ditto', [built, installed]);
  const home = tmp('l7.2-home');
  const { _electron } = await import('@playwright/test');
  const t0 = Date.now();
  const app = await _electron.launch({
    executablePath: join(installed, 'Contents', 'MacOS', 'Director'),
    args: [],
    env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: process.env.TMPDIR, DIRECTOR_USER_DATA: join(home, 'Library', 'Application Support', 'Director'), DIRECTOR_PROJECTS_DIR: join(home, 'Movies', 'Director'), DIRECTOR_BUNDLED_ONLY: '1' },
    timeout: 60_000,
  });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="onboarding"]', { timeout: 30_000 });
    const ms = Date.now() - t0;
    const appInfo = (await win.evaluate(() => window.director.invoke('app:info', {}))).value;
    const binDir = realpathSync(join(installed, 'Contents', 'Resources', 'bin'));
    const missing = ['ffmpeg', 'ffprobe', 'whisper-cli', 'director-native'].filter((n) => !appInfo.sidecars[n] || !realpathSync(appInfo.sidecars[n]).startsWith(binDir));
    assert(!missing.length, `sidecars not from the installed bundle: ${missing.map((n) => `${n}=${appInfo.sidecars[n]}`).join(', ')}`);
    assert(realpathSync(appInfo.userData).startsWith(realpathSync(home)), `user data at ${appInfo.userData}`);
    // A real first run: pick Edit, which creates a project in the fresh profile.
    await win.click('[data-testid="ob-edit"]');
    await win.waitForSelector('[data-testid="workspace-edit"]', { timeout: 30_000 });
    await win.waitForFunction(() => !!globalThis.__directorProject?.().doc, null, { timeout: 30_000 });
    const dir = await win.evaluate(() => globalThis.__directorProject().dir);
    assert(realpathSync(dir).startsWith(realpathSync(home)), `project created at ${dir}`);
    return `ad-hoc signed Director.app (${files.length} files in app.asar, no node_modules) installed by ditto to a new folder; on an empty HOME it opened first-run onboarding in ${ms} ms, resolved all 4 sidecars from its own bundle with Homebrew off PATH, and created its first project in the new profile`;
  } finally { await app.close(); }
}
