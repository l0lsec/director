import { assert } from '../lib.mjs';
import { launchStudio, openProject } from '../swipe-lib.mjs';

// Every command any module registers must have a description and be findable and runnable from Cmd+K,
// without first visiting the workspace that defines it.
export default async function () {
  const { app, win } = await launchStudio({ tab: 'record' });
  try {
    await openProject(win);
    await win.click('[data-testid="tab-record"]');
    await win.waitForFunction(() => globalThis.__directorCommands?.().some((c) => c.id === 'edit.director') && globalThis.__directorCommands().some((c) => c.id === 'swipe.import'), null, { timeout: 15_000 });
    const all = await win.evaluate(() => globalThis.__directorCommands());
    const missing = all.filter((c) => !c.description || c.description.trim().length < 8 || !c.title || !c.group);
    assert(!missing.length, `commands without a proper title, group or description: ${missing.map((c) => c.id).join(', ')}`);
    assert(new Set(all.map((c) => c.title.toLowerCase())).size === all.length, 'two commands share a title');
    const unreachable = [];
    for (const c of all.filter((x) => x.enabled)) {
      await win.keyboard.press('Meta+K');
      await win.waitForSelector('[data-testid="palette-input"]');
      await win.fill('[data-testid="palette-input"]', c.title);
      const top = await win.evaluate(() => [...document.querySelectorAll('[role="option"][data-command]')].slice(0, 5).map((o) => o.getAttribute('data-command')));
      if (!top.includes(c.id)) unreachable.push(`${c.id} (top: ${top.join(', ')})`);
      await win.keyboard.press('Escape');
    }
    assert(!unreachable.length, `not in the top 5 for their own title: ${unreachable.join('; ')}`);
    // Running from the palette works (keyboard only): go to Swipe.
    await win.keyboard.press('Meta+K');
    await win.fill('[data-testid="palette-input"]', 'Go to Swipe');
    await win.keyboard.press('Enter');
    await win.waitForSelector('[data-testid="workspace-swipe"]');
    const groups = [...new Set(all.map((c) => c.group))].sort();
    return `${all.length} commands in ${groups.length} groups (${groups.join(', ')}), all described, each found by its title in the palette; Enter runs the top result`;
  } finally { await app.close(); }
}
