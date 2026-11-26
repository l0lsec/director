import { assert, vitest, fixture } from '../lib.mjs';
import { launchStudio, libCall, call, responses, requestLog } from '../swipe-lib.mjs';

// Runtime computed here, without the app's parser: spoken words are the tokens outside [cues].
function runtime(text, wpm) {
  const pauses = (text.match(/\[PAUSE\]/gi) ?? []).length;
  const words = text.replace(/\[[^\]]*\]/g, ' ').split(/[\s,;:!?]+/).map((w) => w.replace(/[^A-Za-z0-9']/g, '')).filter(Boolean).length;
  return { seconds: (words / wpm) * 60 + pauses * 0.6, words };
}

export default async function () {
  const unit = vitest(['packages/ai/test/ai.test.ts'], { pattern: 'draft', min: 3 });
  const R = responses();
  const { app, win, log } = await launchStudio({ replay: { structure: R.structure.reel, draft: [R.draft.long, R.draft.revised, R.draft.fit] } });
  try {
    const b = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const voice = await libCall(win, 'studio.createVoice', b, { name: 'Coach', rules: ['Short sentences'], wpm: 160 });
    const [ref] = (await call(win, 'swipe:import', { brandId: b, paths: [fixture('reference-reel.mp4')] })).added;
    await call(win, 'swipe:analyze', { brandId: b, id: ref.id });
    await call(win, 'claude:structure', { brandId: b, refId: ref.id });
    await win.evaluate(() => { globalThis.__deltas = 0; window.director.on('claude:text', () => { globalThis.__deltas++; }); });
    // From the reference: Draft my version opens the Script studio with it selected.
    await win.click(`.ref-card[data-ref="${ref.id}"]`);
    await win.click('[data-testid="draft-from-ref"]');
    await win.waitForSelector('[data-testid="draft-tab"]');
    assert((await win.inputValue('select[aria-label="Reference"]')) === ref.id, 'reference preselected');
    await win.selectOption('select[aria-label="Voice"]', voice.id);
    await win.fill('textarea[aria-label="Topic"]', 'Editing for retention');
    await win.fill('input[aria-label="Length in seconds"]', '28');
    const results = [];
    for (const expectRevisions of [1, 0]) {
      await win.click('[data-testid="run-draft"]');
      await win.waitForSelector('[data-testid="keep-draft"]', { timeout: 30_000 });
      await win.click('[data-testid="keep-draft"]');
      await win.waitForFunction(async ({ b, n }) => (await globalThis.__directorLib.lib('studio.scripts', b)).length === n, { b, n: results.length + 1 });
      const scripts = await libCall(win, 'studio.scripts', b);
      const s = scripts.find((x) => !results.some((r) => r.id === x.id));
      const est = runtime(s.current.text, s.current.wpm);
      const off = Math.abs(est.seconds - 28) / 28;
      assert(off <= 0.1, `draft runs ${est.seconds.toFixed(1)} s (${est.words} words), ${(off * 100).toFixed(1)}% off the 28 s target`);
      assert(s.refId === ref.id && s.voiceId === voice.id && s.current.targetSec === 28 && s.current.note === 'drafted with Claude', `script metadata ${JSON.stringify({ refId: s.refId, voiceId: s.voiceId, t: s.current.targetSec })}`);
      results.push({ id: s.id, est, expectRevisions });
      await win.waitForFunction(() => !document.querySelector('[data-testid="keep-draft"]') || true);
    }
    const reqs = requestLog(log).filter((q) => q.task === 'draft');
    assert(reqs.length === 3, `${reqs.length} draft requests (expected first draft, one revision, second draft)`);
    const first = JSON.stringify(reqs[0].request);
    assert(first.includes('Editing for retention') && first.includes('hook 0.0-4.5 s') && first.includes('about 75 spoken words'), 'draft request lacks topic, reference structure or word target');
    assert(reqs[1].request.messages.map((m) => m.role).join() === 'user,assistant,user' && /135 spoken words/.test(reqs[1].request.messages[2].content[0].text), 'revision request does not carry the measured count');
    assert(reqs[0].request.system.length === 2 && reqs[0].request.system[1].cache_control?.type === 'ephemeral', 'voice context is not the cached block');
    assert((await win.evaluate(() => globalThis.__deltas)) > 5, 'draft text was not streamed');
    return `${unit}; app: from a labelled reference, two drafts saved (one revised once for length): ${results.map((r) => `${r.est.seconds.toFixed(1)} s / ${r.est.words} words`).join(', ')} against a 28 s target, streamed`;
  } finally { await app.close(); }
}
