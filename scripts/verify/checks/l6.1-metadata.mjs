import { assert, vitest, fixture } from '../lib.mjs';
import { launchStudio, libCall, call } from '../swipe-lib.mjs';

const order = (win) => win.evaluate(() => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')));

export default async function () {
  const unit = vitest(['packages/library/test/library.test.ts'], { pattern: 'metadata', min: 2 });
  const { app, win } = await launchStudio();
  try {
    const brandId = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const names = ['reference-reel.mp4', 'cuts-720p.mp4', 'vertical-1080x1920.mp4', 'sync-1080p30.mp4'];
    const imp = await call(win, 'swipe:import', { brandId, paths: names.map((n) => fixture(n)) });
    const [a, b, c, d] = imp.added;
    assert(imp.added.length === 4, `imported ${imp.added.length}`);
    // Stats typed into the detail panel save on blur.
    await win.evaluate(() => globalThis.__directorLib.lib('brands.list'));
    await win.click('[data-testid="tab-script"]');
    await win.click('[data-testid="tab-swipe"]');
    await win.waitForSelector(`[data-ref="${a.id}"]`);
    await win.click(`.ref-card[data-ref="${a.id}"]`);
    await win.fill('[data-testid="ref-detail"] input[aria-label="Views"]', '12000');
    await win.fill('[data-testid="ref-detail"] input[aria-label="Likes"]', '900');
    await win.fill('[data-testid="ref-detail"] input[aria-label="Folder"]', 'Hooks / Questions');
    await win.fill('[data-testid="ref-detail"] input[aria-label="Tags"]', 'Hook, #List');
    await win.click('[data-testid="ref-detail"] input[aria-label="Title"]');
    await win.waitForFunction(async (id) => { const r = await globalThis.__directorLib.lib('swipe.get', await globalThis.__directorLib.activeBrand(), id); return r.views === 12000 && r.likes === 900 && r.folder === 'Hooks/Questions' && r.tags.join() === 'hook,list'; }, a.id, { timeout: 10_000 });
    await libCall(win, 'swipe.update', brandId, b.id, { views: 50000, likes: 1000, comments: 10, shares: 0, folder: 'Hooks' });
    await libCall(win, 'swipe.update', brandId, c.id, { views: 3000, likes: 600, comments: 0, shares: 0 });
    const kit = await libCall(win, 'swipe.createKit', brandId, 'Launch');
    await libCall(win, 'swipe.update', brandId, c.id, { kitId: kit.id });
    await libCall(win, 'swipe.setTags', brandId, c.id, ['list']);
    // Independent expectations from the numbers above.
    const stats = { [a.id]: { v: 12000, e: 900 / 12000 }, [b.id]: { v: 50000, e: 1010 / 50000 }, [c.id]: { v: 3000, e: 600 / 3000 } };
    const byViews = Object.keys(stats).sort((x, y) => stats[y].v - stats[x].v).concat(d.id);
    const byEng = Object.keys(stats).sort((x, y) => stats[y].e - stats[x].e).concat(d.id);
    await win.selectOption('select[aria-label="Sort"]', 'views');
    await win.waitForFunction((want) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).join() === want.join(), byViews, { timeout: 10_000 });
    await win.selectOption('select[aria-label="Sort"]', 'engagement');
    await win.waitForFunction((want) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).join() === want.join(), byEng, { timeout: 10_000 });
    // Filters from the sidebar.
    await win.click('.swipe-side button:has-text("#list")');
    await win.waitForFunction((want) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).sort().join() === want, [a.id, c.id].sort().join(), { timeout: 10_000 })
      .catch(async () => { throw new Error(`tag filter shows ${(await order(win)).join()} (want ${a.id},${c.id}); sidebar: ${await win.evaluate(() => [...document.querySelectorAll('.swipe-side button')].map((b) => b.textContent + ':' + b.getAttribute('aria-pressed')).join(' | '))}`); });
    await win.click('.swipe-side button:has-text("Hooks")');
    await win.waitForFunction((want) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).sort().join() === want, [a.id, b.id].sort().join(), { timeout: 10_000 })
      .catch(async () => { throw new Error(`Hooks folder (with subfolder) shows ${(await order(win)).join()}`); });
    await win.click('.swipe-side button:has-text("Launch")');
    await win.waitForFunction((id) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).join() === id, c.id, { timeout: 10_000 });
    await win.click('.swipe-side button:has-text("All references")');
    await win.fill('input[aria-label="Search references"]', 'cuts');
    await win.waitForFunction((id) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).join() === id, b.id, { timeout: 10_000 });
    const bad = await win.evaluate(async (id) => window.director.invoke('library:call', { method: 'swipe.update', args: [await globalThis.__directorLib.activeBrand(), id, { views: -5 }] }), a.id);
    assert(!bad.ok && /at least 0/.test(bad.error.message), 'negative views rejected');
    return `${unit}; app: stats, folder and tags saved from the detail panel; sort by views and engagement, tag, folder (with subfolder), kit and search filters match hand-computed order`;
  } finally { await app.close(); }
}
