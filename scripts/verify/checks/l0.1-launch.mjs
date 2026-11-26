import { launchApp, assert } from '../lib.mjs';

export default async function () {
  const app = await launchApp();
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="tab-record"]', { timeout: 20_000 });
    const tabs = await win.$$eval('[role="tab"]', (els) => els.map((e) => e.textContent?.trim()));
    assert(JSON.stringify(tabs) === JSON.stringify(['Swipe', 'Script', 'Record', 'Edit', 'Export']), `tabs were ${JSON.stringify(tabs)}`);
    for (const id of ['swipe', 'script', 'record', 'edit', 'export']) {
      await win.click(`[data-testid="tab-${id}"]`);
      await win.waitForSelector(`[data-testid="workspace-${id}"]`, { timeout: 10_000 });
    }
    const info = await win.evaluate(() => window.director.invoke('app:info', {}));
    assert(info.ok && info.value.platform === 'darwin', `app:info failed: ${JSON.stringify(info)}`);
  } finally {
    const proc = app.process();
    await app.close();
    await new Promise((r) => setTimeout(r, 300));
    assert(proc.exitCode === 0 || proc.exitCode === null && proc.signalCode === null, `app exit code ${proc.exitCode} signal ${proc.signalCode}`);
  }
  return 'app launched, 5 tabs switch, IPC answered, clean quit';
}
