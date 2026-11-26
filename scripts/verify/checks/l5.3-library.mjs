import { assert, fixture, tmp } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export default async function () {
  const root = tmp('audiolib');
  mkdirSync(join(root, 'Music'), { recursive: true });
  mkdirSync(join(root, 'SFX'), { recursive: true });
  copyFileSync(fixture('speech.wav'), join(root, 'Music', 'Bed track.wav'));
  copyFileSync(fixture('tone-440.wav'), join(root, 'SFX', 'whoosh.wav'));
  copyFileSync(fixture('click-120bpm.wav'), join(root, 'SFX', 'clicks.wav'));
  const { app, win } = await launchEditor();
  try {
    await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'audio' }));
    await win.waitForFunction(() => !!globalThis.__directorAudioLib);
    await win.evaluate((f) => globalThis.__directorAudioLib.setFolders(f), [join(root, 'Music'), join(root, 'SFX')]);
    await win.waitForFunction(() => document.querySelectorAll('[data-sound]').length >= 3, null, { timeout: 30_000 });
    const items = await win.evaluate(() => globalThis.__directorAudioLib.items());
    const rows = await win.evaluate(() => [...document.querySelectorAll('[data-sound]')].map((r) => ({ name: r.getAttribute('data-sound'), preview: !!r.querySelector('button'), meta: r.querySelector('.hint')?.textContent })));
    const want = { 'Bed track.wav': 'music', 'whoosh.wav': 'sfx', 'clicks.wav': 'sfx' };
    for (const [n, k] of Object.entries(want)) {
      const it = items.find((i) => i.name === n);
      assert(it && it.kind === k && it.durationUs > 3_000_000, `${n}: ${JSON.stringify(it)}`);
      const row = rows.find((r) => r.name === n);
      assert(row && row.preview && /\d:\d\d/.test(row.meta), `${n} row ${JSON.stringify(row)}`);
    }
    return `${items.length} sounds listed with kind, duration and preview: ${rows.map((r) => `${r.name} (${r.meta})`).join('; ')}`;
  } finally { await app.close(); }
}
