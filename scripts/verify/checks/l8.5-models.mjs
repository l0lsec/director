import { readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert, tmp } from '../lib.mjs';
import { launchStudio } from '../swipe-lib.mjs';

// Settings > Transcription: every model listed, the one in use marked, and a download that starts, reports
// progress and cancels cleanly (into a scratch models folder, so nothing of the person's is touched).
export default async function () {
  const models = tmp('l8.5-models');
  mkdirSync(models, { recursive: true });
  const { app, win } = await launchStudio({ tab: 'edit', env: { DIRECTOR_MODELS_DIR: models } });
  try {
    await win.click('[data-testid="open-settings"]');
    await win.waitForSelector('[data-testid="transcription-settings"]');
    const rows = await win.$$eval('[data-testid^="model-"]', (els) => els.map((e) => ({ id: e.dataset.testid.slice(6), text: e.textContent })));
    assert(rows.length === 3 && rows.map((r) => r.id).join() === 'large-v3-turbo,small.en,base.en', `rows ${JSON.stringify(rows)}`);
    const inUse = rows.filter((r) => /in use/.test(r.text)).map((r) => r.id);
    assert(inUse.length <= 1, `more than one model in use: ${inUse}`);
    // A model not installed anywhere can be downloaded; pick one that shows a Download button.
    const target = rows.find((r) => /Download/.test(r.text));
    let note = 'every model already installed; download not exercised';
    if (target) {
      await win.click(`[data-testid="model-${target.id}"] button`);
      await win.waitForSelector(`[data-testid="model-${target.id}"] progress`, { timeout: 30_000 });
      await win.click(`[data-testid="model-${target.id}"] button:has-text("Cancel")`);
      await win.waitForSelector(`[data-testid="model-${target.id}"] button:has-text("Download")`, { timeout: 30_000 });
      const left = readdirSync(models).filter((f) => f.includes('ggml'));
      assert(!left.some((f) => !f.endsWith('.partial')), `a cancelled download left a finished model file: ${left}`);
      note = `${target.id} download started with a progress bar and cancelled, keeping only the resumable part (${left.join(', ') || 'nothing'})`;
    }
    return `Settings > Transcription lists ${rows.length} models (in use: ${inUse[0] ?? 'none'}); ${note}`;
  } finally { await app.close(); }
}
