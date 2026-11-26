import { assert, vitest, fixture, groundTruth } from '../lib.mjs';
import { launchStudio, libCall, call, responses, directorProject } from '../swipe-lib.mjs';

// Price table per million tokens (claude-api skill, cached 2026-11-03): input, output, cache read, cache write (5 min).
const PRICES = { 'claude-opus-5-5': [4, 20, 0.2, 5], 'claude-sonnet-5-5': [2, 10, 0.1, 2.5], 'claude-haiku-5-5': [0.1, 0.5, 0.01, 0.125] };
const dollars = (model, u) => {
  const [i, o, r, w] = PRICES[model];
  return (u.input_tokens * i + u.output_tokens * o + (u.cache_read_input_tokens ?? 0) * r + (u.cache_creation_input_tokens ?? 0) * w) / 1e6;
};

export default async function () {
  const unit = vitest(['packages/ai/test/ai.test.ts'], { pattern: 'usage meter', min: 1 });
  const R = responses();
  const sonnetHooks = { ...R.hooks, model: 'claude-sonnet-5-5' };
  const haikuVoice = { ...R.voice, model: 'claude-haiku-5-5' };
  const replay = { director: R.director.valid, hooks: [R.hooks, sonnetHooks], voice: haikuVoice, draft: [R.draft.long, R.draft.revised] };
  const { app, win } = await launchStudio({ replay, tab: 'edit' });
  try {
    await directorProject(win, groundTruth(), fixture);
    const b = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const voice = await libCall(win, 'studio.createVoice', b, { name: 'Coach' });
    const costs = [];
    await win.click('[data-testid="run-director"]');
    await win.waitForSelector('[data-testid="director-proposal"]', { timeout: 30_000 });
    const shown = await win.textContent('[data-testid="director-proposal"] span.hint');
    costs.push(dollars('claude-opus-5-5', R.director.valid.usage));
    assert(shown.startsWith(`$${costs[0].toFixed(4)}`), `Director panel shows ${shown}, expected $${costs[0].toFixed(4)}`);
    const h1 = await call(win, 'claude:hooks', { brandId: b, voiceId: voice.id, topic: 'x' });
    costs.push(dollars('claude-opus-5-5', R.hooks.usage));
    await call(win, 'claude:setModel', { model: 'claude-sonnet-5-5' });
    const h2 = await call(win, 'claude:hooks', { brandId: b, voiceId: voice.id, topic: 'x' });
    costs.push(dollars('claude-sonnet-5-5', sonnetHooks.usage));
    const v = await call(win, 'claude:voiceCheck', { brandId: b, voiceId: voice.id, script: 'Hi.' });
    costs.push(dollars('claude-haiku-5-5', haikuVoice.usage));
    const d = await call(win, 'claude:draft', { brandId: b, voiceId: voice.id, topic: 'x', targetSec: 28, requestId: 'c1' });
    costs.push(dollars('claude-opus-5-5', R.draft.long.usage) + dollars('claude-opus-5-5', R.draft.revised.usage));
    const each = [h1.costUsd, h2.costUsd, v.costUsd, d.costUsd];
    const want = costs.slice(1);
    each.forEach((c, i) => assert(Math.abs(c - want[i]) < 1e-12, `call ${i}: $${c} vs $${want[i]}`));
    const st = await call(win, 'claude:status', {});
    const total = costs.reduce((a, x) => a + x, 0);
    assert(Math.abs(st.usage.costUsd - total) < 1e-12, `month total $${st.usage.costUsd} vs $${total}`);
    assert(st.usage.calls === 6, `${st.usage.calls} calls (the draft counts its revision)`);
    const byTask = Object.fromEntries(st.usage.byTask.map((t) => [t.task, t]));
    assert(byTask.hooks.calls === 2 && Math.abs(byTask.hooks.costUsd - costs[1] - costs[2]) < 1e-12, 'hooks subtotal');
    // The usage meter in Settings shows the same total.
    await win.click('[data-testid="open-settings"]');
    const meter = await win.textContent('[data-testid="usage-meter"] strong');
    assert(meter.includes(`$${total.toFixed(total < 1 ? 4 : 2)} over 6 calls`), `meter shows "${meter}"`);
    return `${unit}; app: Opus, Sonnet and Haiku usage blocks priced per the table, per call and in the month total ($${total.toFixed(4)} over 6 calls), shown in the Director panel and the Settings meter`;
  } finally { await app.close(); }
}
