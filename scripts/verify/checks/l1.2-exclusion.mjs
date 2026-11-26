import { assert, sh, root, launchApp, tmp } from '../lib.mjs';
import { join } from 'node:path';

// Needs macOS Screen Recording permission for the process running the check.
// Opens the prompter showing a unique magenta marker, records the screen, and requires zero magenta pixels.
export default async function () {
  const bin = join(root, 'native/DirectorKit/.build/release/director-native');
  const probe = sh(bin, ['screen-sources'], { allowFail: true });
  assert(probe.status === 0, `screen capture not permitted: ${probe.stdout.trim()}`);
  const app = await launchApp({ env: { DIRECTOR_SHOW: '1' } });
  const out = join(tmp('exclusion'), 'screen.mov');
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="tab-record"]');
    const info = await win.evaluate(async () => {
      const r = globalThis.__directorRecord;
      r.setScript('MAGENTA MARKER LINE');
      await r.openPrompter('overlay');
      await new Promise((res) => setTimeout(res, 800));
      await window.director.invoke('prompter:update', { state: { ...r.prompterState(), settings: { ...r.prompterState().settings, color: '#ff00ff', background: '#ff00ff', opacity: 1 } } });
      return (await window.director.invoke('prompter:info', {})).value;
    });
    assert(info.open && info.windowId, 'prompter open with a window id');
    sh(bin, ['screen-record', '--out', out, '--exclude-window', String(info.windowId), '--max-seconds', '3'], { timeout: 30_000 });
  } finally { await app.close(); }
  const res = sh('ffmpeg', ['-v', 'error', '-i', out, '-vf', "format=rgb24,geq=r='if(gt(r(X,Y),220)*lt(g(X,Y),40)*gt(b(X,Y),220),255,0)':g=0:b=0,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-", '-f', 'null', '-']);
  const maxY = Math.max(0, ...[...res.stdout.matchAll(/YMAX=(\d+)/g)].map((m) => Number(m[1])));
  assert(maxY < 60, `magenta prompter pixels found in the screen recording (YMAX ${maxY})`);
  return 'no prompter pixels in the screen recording';
}
