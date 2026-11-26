import { assert, vitest } from '../lib.mjs';
import { launchStudio, libCall, responses, requestLog } from '../swipe-lib.mjs';

const SCRIPT = 'Hey guys, welcome back to the channel.\n\nHere is my three second rule.\nLeverage this rule to cut faster.\nThat means the pause before you talk, the um, the restart, all of it, every time.\nFollow for more synergy.';

export default async function () {
  const unit = vitest(['packages/ai/test/ai.test.ts'], { pattern: 'voice findings', min: 1 });
  const R = responses();
  const { app, win, log } = await launchStudio({ replay: { voice: R.voice }, tab: 'script' });
  try {
    const b = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const voice = await libCall(win, 'studio.createVoice', b, { name: 'Coach', banned: ['leverage', 'synergy'], rules: ['Short sentences'] });
    const s = await libCall(win, 'studio.createScript', b, { title: 'Check me', text: SCRIPT, wpm: 160, voiceId: voice.id });
    await win.click(`[data-script="${s.id}"]`);
    await win.click('button[role="tab"]:has-text("Voice check")');
    await win.selectOption('select[aria-label="Voice to check against"]', voice.id);
    await win.click('button:has-text("Check against voice")');
    await win.waitForSelector('.finding[data-line]', { timeout: 30_000 });
    const lines = SCRIPT.split('\n').map((l) => l.trim()).filter(Boolean);
    const findings = await win.evaluate(() => [...document.querySelectorAll('.finding[data-line]')].map((f) => ({ line: Number(f.getAttribute('data-line')), text: f.querySelector('.hint').textContent, cls: f.className })));
    const problems = [];
    for (const f of findings) {
      if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines.length) problems.push(`line ${f.line} out of range`);
      else if (f.text !== `Line ${f.line}: ${lines[f.line - 1]}`) problems.push(`line ${f.line} shows "${f.text}"`);
      if (!/\b(info|warn|fix)\b/.test(f.cls)) problems.push(`line ${f.line} has no severity`);
    }
    assert(!problems.length, problems.join('; '));
    assert(findings.map((f) => f.line).join() === '1,3,4,5', `findings on lines ${findings.map((f) => f.line).join()}`);
    assert(findings.find((f) => f.line === 5).cls.includes('fix'), 'banned "synergy" on line 5 is flagged (caught locally)');
    assert(await win.isVisible('text=1 finding(s) ignored'), 'the out-of-range finding is reported as ignored');
    // Applying a suggestion edits exactly that line.
    await win.click('.finding[data-line="3"] button:has-text("Apply")');
    const edited = await win.inputValue('[data-testid="script-text"]');
    assert(edited.split('\n')[2] === 'Use this rule to cut faster.' && edited.split('\n').length === 5, `after apply: ${JSON.stringify(edited)}`);
    const req = requestLog(log).find((q) => q.task === 'voice');
    assert(req && JSON.stringify(req.request).includes('5. Follow for more synergy.'), 'lines are numbered in the request');
    return `${unit}; app: ${findings.length} line-level findings on lines ${findings.map((f) => f.line).join(', ')} of ${lines.length}, all in range with severities, one bad reference ignored, suggestion applied to its line`;
  } finally { await app.close(); }
}
