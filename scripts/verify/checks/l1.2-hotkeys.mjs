import { launchApp, assert } from '../lib.mjs';

const KEYS = [[' ', 'Space'], ['ArrowUp', 'Up'], ['ArrowDown', 'Down'], ['r', 'R'], ['m', 'M'], ['g', 'G'], ['b', 'B'], ['Escape', 'Escape']];

export default async function () {
  const app = await launchApp();
  try {
    const studio = await app.firstWindow();
    await studio.waitForSelector('[data-testid="tab-record"]');
    await studio.click('[data-testid="tab-record"]');
    await studio.waitForSelector('[data-testid="record-workspace"]');
    await studio.evaluate(() => globalThis.__directorRecord.setOption('mode', 'manual'));
    const last = () => studio.evaluate(() => globalThis.__directorLastKey);
    // 1. Studio window focused.
    for (const [press, name] of KEYS) {
      await studio.evaluate(() => { globalThis.__directorLastKey = null; document.activeElement?.blur?.(); });
      await studio.keyboard.press(press);
      await studio.waitForFunction((n) => globalThis.__directorLastKey === n, name, { timeout: 3000 }).catch(() => {});
      assert((await last()) === name, `studio: ${press} -> ${await last()}`);
    }
    // 2. Prompter window focused: keys relay through main to the studio.
    const [prompter] = await Promise.all([app.waitForEvent('window'), studio.evaluate(() => globalThis.__directorRecord.openPrompter('overlay'))]);
    await prompter.waitForSelector('[data-testid="prompter"]');
    for (const [press, name] of KEYS) {
      await studio.evaluate(() => { globalThis.__directorLastKey = null; });
      await prompter.keyboard.press(press);
      await studio.waitForFunction((n) => globalThis.__directorLastKey === n, name, { timeout: 3000 }).catch(() => {});
      assert((await last()) === name, `prompter: ${press} -> ${await last()}`);
    }
    // 3. Global shortcuts while recording (another app focused): all keys register system-wide.
    const armed = await studio.evaluate(async () => (await window.director.invoke('hotkeys:arm', { on: true })).value);
    await studio.evaluate(async () => window.director.invoke('hotkeys:arm', { on: false }));
    assert(KEYS.every(([, n]) => armed.includes(n)), `global shortcuts registered: ${JSON.stringify(armed)}`);
    return `8 keys handled from the studio window, the prompter window, and as global shortcuts (${armed.join(', ')})`;
  } finally { await app.close(); }
}
