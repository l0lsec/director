import { assert } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';

const toPlaywright = (combo) => combo.split('+').map((p) => ({ Cmd: 'Meta', Alt: 'Alt', Shift: 'Shift', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown', '=': 'Equal', '-': 'Minus', '\\': 'Backslash' }[p] ?? (p.length === 1 ? p.toLowerCase() : p))).join('+');

export default async function () {
  const { app, win } = await launchEditor();
  try {
    const audit = await win.evaluate(() => globalThis.__directorKeymap.auditPresets());
    for (const [name, a] of Object.entries(audit)) {
      assert(a.unbound.length === 0, `${name} leaves commands unbound: ${a.unbound.join(', ')}`);
      assert(a.duplicates.length === 0, `${name} has duplicate shortcuts: ${a.duplicates.join(', ')}`);
    }
    const presets = await win.evaluate(() => globalThis.__directorKeymap.PRESETS);
    const skip = new Set(['edit.play', 'edit.shuttleForward', 'edit.save', 'edit.makeReel']); // side effects verified elsewhere
    let pressed = 0;
    const wrong = [];
    for (const [name, map] of Object.entries(presets)) {
      await win.evaluate((n) => globalThis.__directorKeymap.setPreset(n), name);
      for (const [combo, id] of Object.entries(map)) {
        if (skip.has(id)) continue;
        await win.evaluate(() => { globalThis.__directorLastCommand = null; document.activeElement?.blur?.(); });
        await win.keyboard.press(toPlaywright(combo));
        await win.waitForTimeout(25);
        const got = await win.evaluate(() => globalThis.__directorLastCommand);
        if (got !== id) wrong.push(`${name} ${combo}: expected ${id}, got ${got}`);
        pressed++;
      }
    }
    assert(wrong.length === 0, `shortcuts did not reach their command:\n${wrong.join('\n')}`);
    return `${pressed} shortcuts across CapCut and Premiere presets reach their commands; no unbound commands, no duplicates`;
  } finally { await app.close(); }
}
