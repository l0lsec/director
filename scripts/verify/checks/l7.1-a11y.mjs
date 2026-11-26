import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, fixture, groundTruth, root } from '../lib.mjs';
import { launchStudio, call, libCall, directorProject } from '../swipe-lib.mjs';

const AXE = readFileSync(join(root, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');

async function scan(win, label) {
  await win.evaluate((src) => { if (!globalThis.axe) (0, eval)(src); }, AXE);
  const r = await win.evaluate(async () => {
    const res = await globalThis.axe.run(document, { resultTypes: ['violations'] });
    return res.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) , count: v.nodes.length }));
  });
  return r.map((v) => ({ ...v, where: label }));
}

export default async function () {
  const { app, win } = await launchStudio({ tab: 'edit' });
  try {
    // Real content in every workspace, so the scan covers populated views, not empty states only.
    await directorProject(win, groundTruth(), fixture);
    const b = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const [ref] = (await call(win, 'swipe:import', { brandId: b, paths: [fixture('reference-reel.mp4')] })).added;
    await call(win, 'swipe:analyze', { brandId: b, id: ref.id, transcribe: false });
    const voice = await libCall(win, 'studio.createVoice', b, { name: 'Coach' });
    const s = await libCall(win, 'studio.createScript', b, { title: 'Episode', text: '[HOOK] Hello there.\nSecond line.', wpm: 160, voiceId: voice.id });
    await libCall(win, 'studio.addHook', b, { text: 'Nobody tells you this' });
    const found = [];
    found.push(...await scan(win, 'edit (director panel)'));
    for (const panel of ['media', 'transcript', 'captions', 'text', 'audio']) {
      await win.evaluate((p) => globalThis.__directorEditCmd.setEdit({ panel: p }), panel);
      await win.waitForTimeout(150);
      found.push(...await scan(win, `edit (${panel})`));
    }
    await win.click('[data-testid="tab-swipe"]');
    await win.click(`.ref-card[data-ref="${ref.id}"]`);
    await win.waitForSelector('[data-testid="pacing"]');
    found.push(...await scan(win, 'swipe'));
    await win.click('[data-testid="tab-script"]');
    await win.click(`[data-script="${s.id}"]`);
    found.push(...await scan(win, 'script'));
    for (const t of ['Voices', 'Hooks']) { await win.click(`.sc-left button[role="tab"]:has-text("${t}")`); found.push(...await scan(win, `script (${t})`)); }
    await win.click('[data-testid="tab-record"]');
    await win.waitForTimeout(500);
    found.push(...await scan(win, 'record'));
    await win.click('[data-testid="tab-export"]');
    await win.waitForSelector('[data-testid="export-workspace"]');
    found.push(...await scan(win, 'export'));
    await win.click('[data-testid="open-settings"]');
    await win.waitForSelector('[data-testid="settings"]');
    found.push(...await scan(win, 'settings'));
    await win.keyboard.press('Escape');
    await win.click('[data-testid="tab-swipe"]');
    await win.keyboard.press('Meta+K');
    await win.waitForSelector('[data-testid="palette-input"]');
    found.push(...await scan(win, 'command palette'));
    await win.keyboard.press('Escape');
    const bad = found.filter((v) => v.impact === 'critical' || v.impact === 'serious');
    const minor = found.filter((v) => !(v.impact === 'critical' || v.impact === 'serious'));
    assert(!bad.length, `${bad.length} critical/serious:\n${bad.map((v) => `[${v.where}] ${v.impact} ${v.id}: ${v.help} (${v.count}) ${v.nodes.join(' ; ')}`).join('\n')}`);
    return `axe-core 4.14 on 14 views (all workspaces, edit panels, script tabs, settings, palette): 0 critical, 0 serious; ${minor.length} moderate/minor (${[...new Set(minor.map((v) => v.id))].join(', ') || 'none'})`;
  } finally { await app.close(); }
}
