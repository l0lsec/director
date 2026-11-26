import { assert, vitest, fixture } from '../lib.mjs';
import { launchStudio, libCall, call } from '../swipe-lib.mjs';

const cards = (win) => win.evaluate(() => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).sort().join());

export default async function () {
  const unit = vitest(['packages/library/test/library.test.ts'], { pattern: 'brands', min: 1 });
  const { app, win } = await launchStudio();
  try {
    const one = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const shared = fixture('reference-reel.mp4');
    const r1 = (await call(win, 'swipe:import', { brandId: one, paths: [shared, fixture('cuts-720p.mp4')] })).added;
    await libCall(win, 'swipe.setTags', one, r1[0].id, ['only-in-one']);
    const v1 = await libCall(win, 'studio.createVoice', one, { name: 'Voice One' });
    await libCall(win, 'studio.addHook', one, { text: 'Hook from brand one' });
    await libCall(win, 'studio.createScript', one, { title: 'Script One', text: 'Hello.', wpm: 160, voiceId: v1.id });
    await libCall(win, 'brands.savePreset', one, 'Brand one bold', { styleId: 'bold' });
    // Create the second brand through the UI.
    await win.click('[data-testid="tab-script"]');
    await win.click('[data-testid="tab-swipe"]');
    await win.waitForFunction((n) => document.querySelectorAll('[data-testid="ref-grid"] [data-ref]').length === n, r1.length);
    await win.click('button[aria-label="New brand"]');
    await win.fill('[data-testid="prompt"] input', 'Client Two');
    await win.click('[data-testid="prompt"] button[type="submit"]');
    await win.waitForFunction(async (one) => (await globalThis.__directorLib.activeBrand()) !== one, one);
    const two = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    await win.waitForSelector('text=Your swipe file is empty');
    const r2 = (await call(win, 'swipe:import', { brandId: two, paths: [shared] })).added;
    assert(r2.length === 1 && r2[0].id !== r1[0].id, 'the same file is its own entry in brand two');
    await win.evaluate(() => globalThis.__directorLib.lib('brands.list'));
    await win.click('[data-testid="tab-script"]');
    await win.click('[data-testid="tab-swipe"]');
    await win.waitForFunction((id) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).join() === id, r2[0].id);
    // Brand two sees nothing of brand one, in the UI and through every library list.
    const leaks = [];
    if ((await libCall(win, 'swipe.list', two)).length !== 1) leaks.push('references');
    if ((await libCall(win, 'swipe.tags', two)).length) leaks.push('tags');
    if ((await libCall(win, 'studio.voices', two)).length) leaks.push('voices');
    if ((await libCall(win, 'studio.hooks', two)).length) leaks.push('hooks');
    if ((await libCall(win, 'studio.scripts', two)).length) leaks.push('scripts');
    if ((await libCall(win, 'brands.presets', two)).length) leaks.push('caption presets');
    if (await libCall(win, 'swipe.get', two, r1[0].id)) leaks.push('reference by id');
    if ((await libCall(win, 'studio.voices', two, true)).some((x) => x.id === v1.id)) leaks.push('voice (including deleted)');
    const cross = await win.evaluate(async ({ two, id }) => window.director.invoke('library:call', { method: 'swipe.update', args: [two, id, { title: 'hijack' }] }), { two, id: r1[0].id });
    if (cross.ok) leaks.push('cross-brand update');
    assert(!leaks.length, `brand two can see brand one's ${leaks.join(', ')}`);
    await win.click('[data-testid="tab-script"]');
    await win.click('button[role="tab"]:has-text("Voices")');
    assert(!(await win.isVisible('text=Voice One')), 'voice from brand one shows in brand two');
    // Switch back with the brand menu: brand one is intact.
    await win.click('[data-testid="tab-swipe"]');
    await win.selectOption('[data-testid="brand-select"]', one);
    await win.waitForFunction((want) => [...document.querySelectorAll('[data-testid="ref-grid"] [data-ref]')].map((e) => e.getAttribute('data-ref')).sort().join() === want, r1.map((r) => r.id).sort().join());
    assert((await cards(win)) === r1.map((r) => r.id).sort().join(), 'brand one grid');
    assert((await libCall(win, 'swipe.get', one, r1[0].id)).title !== 'hijack', 'brand one reference untouched');
    assert((await libCall(win, 'swipe.tags', one)).map((t) => t.tag).join() === 'only-in-one', 'brand one tags intact');
    await win.click('[data-testid="tab-script"]');
    await win.click('button[role="tab"]:has-text("Voices")');
    await win.waitForSelector('text=Voice One');
    const saved = await call(win, 'settings:get', { key: 'brand.active' });
    assert(saved === one, 'active brand persists');
    return `${unit}; app: second brand created from the UI, switching brands scopes references, tags, voices, hooks, scripts and caption presets, cross-brand reads and writes refused`;
  } finally { await app.close(); }
}
