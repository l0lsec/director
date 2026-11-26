import { assert } from '../lib.mjs';
import { launchWithFakeDevices, stopAndGet } from '../capture-lib.mjs';

/** Walk onboarding from first launch to a recording, counting distinct screens shown. */
async function walk(win) {
  const seen = [];
  const note = async () => { const s = await win.getAttribute('[data-testid="onboarding"]', 'data-step').catch(() => null); if (s && seen.at(-1) !== s) seen.push(s); return s; };
  await win.waitForSelector('[data-testid="onboarding"]', { timeout: 20_000 });
  await note();
  await win.click('[data-testid="ob-record"]');
  await win.waitForFunction(() => document.querySelector('[data-testid="onboarding"]')?.getAttribute('data-step') !== 'welcome');
  return { seen, note };
}

async function startAndConfirm(win, seen) {
  assert(seen.length <= 3, `${seen.length} screens before recording: ${seen.join(' > ')}`);
  await win.fill('[data-testid="ob-script"]', '[HOOK] My first take.\nThis is easy.');
  await win.click('[data-testid="ob-start"]');
  await win.waitForFunction(() => globalThis.__directorRecord.get().phase === 'recording', null, { timeout: 30_000 })
    .catch(async () => { throw new Error(`no recording: ${JSON.stringify(await win.evaluate(() => { const r = globalThis.__directorRecord.get(); return { phase: r.phase, stream: !!r.stream, error: r.error, ws: document.querySelector('main')?.getAttribute('data-testid'), ob: !!document.querySelector('[data-testid="onboarding"]'), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }; }))}`); });
  assert(!(await win.isVisible('[data-testid="onboarding"]')), 'onboarding still open while recording');
  const st = await win.evaluate(() => ({ text: globalThis.__directorRecord.get().scriptText, ws: document.querySelector('main')?.getAttribute('data-testid') }));
  assert(st.text.startsWith('[HOOK] My first take.') && st.ws === 'workspace-record', `record state ${JSON.stringify(st)}`);
  await new Promise((r) => setTimeout(r, 1200));
  const res = await stopAndGet(win);
  return res;
}

export default async function () {
  const out = [];
  // 1. Everything already allowed: welcome then script (2 screens), recording starts.
  {
    const { app, win } = await launchWithFakeDevices({ DIRECTOR_ONBOARDING: '1', DIRECTOR_PERMISSIONS: 'camera=granted,microphone=granted,screen=not-determined', DIRECTOR_SHOW: '1' });
    try {
      await win.evaluate(() => globalThis.__directorRecord.setOption('countdownSeconds', 0));
      const { seen, note } = await walk(win);
      await note();
      assert(seen.join() === 'welcome,script', `screens ${seen.join()}`);
      const res = await startAndConfirm(win, seen);
      assert(res.take.script.text.startsWith('[HOOK] My first take.'), 'take has the onboarding script');
      const again = await win.evaluate(() => window.director.invoke('app:onboarding', {}));
      assert(again.value.show === false, 'onboarding would show again');
      out.push('granted: 2 screens to a take');
    } finally { await app.close(); }
  }
  // 2. Not asked yet: Allow buttons prompt (granted), then continue: 3 screens.
  {
    const { app, win } = await launchWithFakeDevices({ DIRECTOR_ONBOARDING: '1', DIRECTOR_PERMISSIONS: 'camera=not-determined,microphone=not-determined,screen=not-determined', DIRECTOR_SHOW: '1' });
    try {
      await win.evaluate(() => globalThis.__directorRecord.setOption('countdownSeconds', 0));
      const { seen, note } = await walk(win);
      await note();
      assert(seen.join() === 'welcome,permissions', `screens ${seen.join()}`);
      assert(await win.isDisabled('[data-testid="ob-continue"]'), 'continue enabled before access');
      await win.click('[data-testid="allow-camera"]');
      await win.waitForSelector('[data-perm="camera"][data-state="granted"]');
      await win.click('[data-testid="allow-microphone"]');
      await win.waitForSelector('[data-perm="microphone"][data-state="granted"]');
      await win.click('[data-testid="ob-continue"]');
      await note();
      await startAndConfirm(win, seen);
      out.push(`not determined: ${seen.length} screens (${seen.join(' > ')}), Allow prompts, take recorded`);
    } finally { await app.close(); }
  }
  // 3. Denied: explained, System Settings opens the right pane, granting there and checking again unblocks.
  {
    const { app, win } = await launchWithFakeDevices({ DIRECTOR_ONBOARDING: '1', DIRECTOR_PERMISSIONS: 'camera=denied,microphone=restricted,screen=denied', DIRECTOR_SHOW: '1' });
    try {
      await win.evaluate(() => globalThis.__directorRecord.setOption('countdownSeconds', 0));
      await app.evaluate(({ shell }) => { globalThis.__opened = []; shell.openExternal = async (u) => { globalThis.__opened.push(u); }; });
      const { seen, note } = await walk(win);
      assert(await win.isDisabled('[data-testid="ob-continue"]'), 'continue enabled while denied');
      assert(await win.isVisible('[data-perm="microphone"] >> text=Blocked by a profile'), 'restricted state not explained');
      assert(await win.isVisible('[data-perm="camera"] >> text=Turned off for Director'), 'denied state not explained');
      await win.click('[data-testid="open-settings-camera"]');
      await win.click('[data-testid="open-settings-microphone"]');
      const opened = await app.evaluate(() => globalThis.__opened);
      assert(opened[0].includes('Privacy_Camera') && opened[1].includes('Privacy_Microphone'), `opened ${opened.join(', ')}`);
      // The person switches Director on in System Settings, then checks again.
      await app.evaluate(() => { globalThis.__directorPermissions.camera = 'granted'; globalThis.__directorPermissions.microphone = 'granted'; });
      await win.click('[data-testid="ob-recheck"]');
      await win.waitForSelector('[data-perm="camera"][data-state="granted"]');
      await win.click('[data-testid="ob-continue"]');
      await note();
      await startAndConfirm(win, seen);
      out.push('denied and restricted: explained, System Settings panes opened, re-check unblocked, take recorded');
    } finally { await app.close(); }
  }
  // 4. Not recording first: one screen to the chosen workspace.
  {
    const { app, win } = await launchWithFakeDevices({ DIRECTOR_ONBOARDING: '1', DIRECTOR_PERMISSIONS: 'camera=denied,microphone=denied,screen=denied', DIRECTOR_SHOW: '1' });
    try {
      await win.waitForSelector('[data-testid="onboarding"]');
      await win.click('[data-testid="ob-swipe"]');
      await win.waitForSelector('[data-testid="workspace-swipe"]');
      assert(!(await win.isVisible('[data-testid="onboarding"]')), 'onboarding still open');
      out.push('study a reference: 1 screen to Swipe');
    } finally { await app.close(); }
  }
  return out.join('; ');
}
