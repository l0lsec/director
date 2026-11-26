import { readFileSync } from 'node:fs';
import { assert, vitest, fixture, groundTruth, root } from '../lib.mjs';
import { launchStudio, libCall, call, responses, directorProject, requestLog } from '../swipe-lib.mjs';

// Every Claude request the app makes, exactly as sent (intercepted in main before the transport),
// must carry only text: no media bytes, no file contents, no paths or media file names.
export default async function () {
  const unit = vitest(['packages/ai/test/ai.test.ts'], { pattern: 'privacy guard', min: 2 });
  const R = responses();
  const { app, win, log, userData, projects } = await launchStudio({ replay: { structure: R.structure.reel, draft: R.draft.fit, hooks: R.hooks, voice: R.voice, release: R.release, director: R.director.valid }, tab: 'edit' });
  try {
    const gt = groundTruth();
    await directorProject(win, gt, fixture);
    const b = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const voice = await libCall(win, 'studio.createVoice', b, { name: 'Coach', examples: ['Here is the thing.'], banned: ['synergy'] });
    const [ref] = (await call(win, 'swipe:import', { brandId: b, paths: [fixture('reference-reel.mp4')] })).added;
    await call(win, 'swipe:analyze', { brandId: b, id: ref.id });
    await call(win, 'claude:structure', { brandId: b, refId: ref.id });
    await call(win, 'claude:draft', { brandId: b, voiceId: voice.id, topic: 'retention', targetSec: 28, refId: ref.id, requestId: 'p1' });
    await call(win, 'claude:hooks', { brandId: b, voiceId: voice.id, topic: 'retention' });
    await call(win, 'claude:voiceCheck', { brandId: b, voiceId: voice.id, script: 'Hello there.\nFollow for more.' });
    const transcript = gt.speech.words.map((w) => w.text).join(' ');
    await call(win, 'claude:release', { brandId: b, voiceId: voice.id, transcript });
    await win.click('[data-testid="run-director"]');
    await win.waitForSelector('[data-testid="director-proposal"]', { timeout: 30_000 });
    const reqs = requestLog(log);
    const tasks = reqs.map((q) => q.task).sort().join();
    assert(tasks === 'director,draft,hooks,release,structure,voice', `logged tasks ${tasks}`);
    const doc = await win.evaluate(() => globalThis.__directorProject().doc);
    const mediaNames = [...Object.values(doc.media).map((m) => m.name), 'reference-reel', 'speech.wav'];
    const needles = [root, userData, projects, '/Users/', '/private/', '/var/folders', ...mediaNames, ...Object.values(doc.media).map((m) => m.path), ...Object.values(doc.media).map((m) => m.hash)];
    const problems = [];
    // Bytes of the actual media, as base64, must never appear (positive identity check, not just a pattern).
    const sample = readFileSync(fixture('speech.wav')).subarray(2000, 2600).toString('base64').slice(0, 120);
    const sampleVideo = readFileSync(fixture('reference-reel.mp4')).subarray(4000, 4600).toString('base64').slice(0, 120);
    for (const q of reqs) {
      const json = JSON.stringify(q.request);
      for (const n of needles) if (n && json.includes(n)) problems.push(`${q.task}: contains ${n}`);
      if (json.includes(sample) || json.includes(sampleVideo)) problems.push(`${q.task}: contains media bytes`);
      if (/[A-Za-z0-9+/]{400,}/.test(JSON.stringify({ s: q.request.system, m: q.request.messages }))) problems.push(`${q.task}: long base64 run`);
      if (/data:[a-z]+\/[a-z0-9.+-]+;base64,/i.test(json)) problems.push(`${q.task}: data URI`);
      for (const m of q.request.messages) for (const blk of m.content) if (blk.type !== 'text') problems.push(`${q.task}: ${blk.type} block`);
      for (const s of q.request.system) if (s.type !== 'text') problems.push(`${q.task}: system ${s.type} block`);
    }
    assert(!problems.length, problems.join('\n'));
    // What was sent is the transcript and timeline text.
    const dir = JSON.stringify(reqs.find((q) => q.task === 'director').request);
    assert(dir.includes('Stop typing plain prompts into Claude') && dir.includes('Lane camera: 1 clip(s)'), 'director request lacks transcript or timeline text');
    const sizes = reqs.map((q) => `${q.task} ${(JSON.stringify(q.request).length / 1024).toFixed(1)} KB`);
    return `${unit}; app: ${reqs.length} intercepted requests (${sizes.join(', ')}) carry text blocks only, with no paths, media names, hashes, data URIs, base64 runs or bytes of the media files`;
  } finally { await app.close(); }
}
