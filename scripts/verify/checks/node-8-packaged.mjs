import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { assert, sh, tmp, ensurePackaged, asarFiles, runChecks } from '../lib.mjs';
import { launchStudio, call } from '../swipe-lib.mjs';

export default async function () {
  const built = ensurePackaged();
  assert(existsSync(join(built, 'Contents', 'Resources', 'mcp-stdio.cjs')), 'the stdio bridge is not in the bundle');
  assert(!asarFiles(join(built, 'Contents', 'Resources', 'app.asar')).some((f) => f.includes('node_modules')), 'app.asar ships node_modules');
  // Installed like a download: copied out of the repo.
  const installed = join(tmp('node-8-Applications'), 'Director.app');
  sh('ditto', [built, installed]);
  const real = realpathSync(installed);
  const { app, win } = await launchStudio({ tab: 'edit', env: { DIRECTOR_PACKAGED_APP: installed } });
  let desk;
  try {
    const st = await call(win, 'mcp:enable', { on: true });
    desk = JSON.parse(st.setup.claudeDesktop).mcpServers.director;
    assert(realpathSync(desk.command).startsWith(real) && realpathSync(desk.args[0]).startsWith(real), `Claude Desktop entry points outside the installed app: ${desk.command} ${desk.args[0]}`);
    assert(st.tools >= 90, `packaged catalog ${st.tools}`);
  } finally { await app.close(); }
  // The stdio bridge and the HTTP API, run against the installed app.
  const r = runChecks(['l8.2-stdio', 'l8.2-rest', 'l8.2-mcp'], { env: { DIRECTOR_PACKAGED_APP: installed } });
  return `installed copy's Claude Desktop entry runs ${desk.command.split('/').slice(-4).join('/')} with Resources/mcp-stdio.cjs; ${r} (against the installed app)`;
}
