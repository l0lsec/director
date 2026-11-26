import { assert, vitest } from '../lib.mjs';
import { launchStudio, libCall } from '../swipe-lib.mjs';

const answer = async (win, text) => { await win.fill('[data-testid="prompt"] input', text); await win.click('[data-testid="prompt"] button[type="submit"]'); };
const until = (win, fn, arg) => win.waitForFunction(fn, arg, { timeout: 10_000 });

export default async function () {
  const unit = vitest(['packages/library/test/library.test.ts'], { pattern: 'studio', min: 2 });
  const { app, win } = await launchStudio({ tab: 'script' });
  try {
    const b = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    // Voice profile: create, edit, delete, restore.
    await win.click('button[role="tab"]:has-text("Voices")');
    await win.click('[data-testid="new-voice"]');
    await win.fill('input[aria-label="Voice name"]', 'Coach');
    await win.fill('textarea[placeholder^="Short sentences"]', 'Short sentences\nSay you');
    await win.fill('input[placeholder="synergy, leverage"]', 'synergy, leverage');
    await win.click('button:has-text("Save voice")');
    await until(win, async (b) => (await globalThis.__directorLib.lib('studio.voices', b)).some((v) => v.name === 'Coach' && v.rules.length === 2 && v.banned.join() === 'synergy,leverage'), b);
    await win.click('.sc-item:has-text("Coach") button:has-text("Edit")');
    await win.fill('input[aria-label="Voice name"]', 'Coach Alex');
    await win.click('button:has-text("Save voice")');
    await until(win, async (b) => (await globalThis.__directorLib.lib('studio.voices', b))[0]?.name === 'Coach Alex', b);
    const [voice] = await libCall(win, 'studio.voices', b);
    await win.click('.sc-item:has-text("Coach Alex") button:has-text("Delete")');
    await until(win, async (b) => (await globalThis.__directorLib.lib('studio.voices', b)).length === 0, b);
    assert(await libCall(win, 'studio.restoreVoice', b, voice.id), 'voice restore');
    await win.waitForSelector('.sc-item:has-text("Coach Alex")');
    // Hook bank: add, delete, restore.
    await win.click('button[role="tab"]:has-text("Hooks")');
    await win.click('button:has-text("Add a hook")');
    await answer(win, 'Nobody tells you this about editing');
    await win.waitForSelector('[data-hook]:has-text("Nobody tells you this")');
    const [hook] = await libCall(win, 'studio.hooks', b);
    await win.click(`[data-hook="${hook.id}"] button:has-text("Delete")`);
    await until(win, (id) => !document.querySelector(`[data-hook="${id}"]`), hook.id);
    assert(await libCall(win, 'studio.restoreHook', b, hook.id), 'hook restore');
    await win.waitForSelector(`[data-hook="${hook.id}"]`);
    // Script: create, edit, save versions, restore an old one, delete, restore.
    await win.click('button[role="tab"]:has-text("Scripts")');
    await win.click('[data-testid="new-script"]');
    await answer(win, 'Episode one');
    await win.waitForSelector('[data-testid="script-text"]');
    await win.fill('[data-testid="script-text"]', 'First version line.');
    await win.click('[data-testid="save-version"]');
    await until(win, async (b) => (await globalThis.__directorLib.lib('studio.scripts', b))[0]?.versions === 2, b);
    await win.fill('[data-testid="script-text"]', 'Second version line.\n[CTA] Follow.');
    await win.click('[data-testid="save-version"]');
    await until(win, async (b) => (await globalThis.__directorLib.lib('studio.scripts', b))[0]?.versions === 3, b);
    const [script] = await libCall(win, 'studio.scripts', b);
    await until(win, () => document.querySelector('select[aria-label="Version history"]').value === '3' && document.querySelectorAll('select[aria-label="Version history"] option').length === 3);
    await win.selectOption('select[aria-label="Version history"]', '2');
    await until(win, async (b) => (await globalThis.__directorLib.lib('studio.scripts', b))[0]?.current.text === 'First version line.', b);
    await until(win, () => document.querySelector('[data-testid="script-text"]').value === 'First version line.')
      .catch(async () => { throw new Error(`editor shows ${JSON.stringify(await win.inputValue('[data-testid="script-text"]'))}, select ${await win.inputValue('select[aria-label="Version history"]')}, db ${JSON.stringify((await libCall(win, 'studio.scripts', b))[0].current)}`); });
    const versions = await libCall(win, 'studio.versions', b, script.id);
    assert(versions.map((v) => v.text).join('|') === '|First version line.|Second version line.\n[CTA] Follow.|First version line.', `history ${JSON.stringify(versions.map((v) => v.text))}`);
    assert(versions.at(-1).note === 'restored v2', 'restore note');
    await win.click('[data-testid="script-editor"] button:has-text("Delete")');
    await until(win, async (b) => (await globalThis.__directorLib.lib('studio.scripts', b)).length === 0, b);
    assert(await libCall(win, 'studio.restoreScript', b, script.id), 'script restore');
    await win.waitForSelector(`[data-script="${script.id}"]`);
    assert((await libCall(win, 'studio.script', b, script.id)).versions === 4, 'history survives delete and restore');
    return `${unit}; app: voice profile created, edited, deleted and restored; hook added, deleted, restored; script saved as 4 versions with v2 restored as v4, deleted and restored with history intact`;
  } finally { await app.close(); }
}
