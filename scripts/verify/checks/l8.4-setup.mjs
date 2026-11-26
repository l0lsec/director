import { spawnSync } from 'node:child_process';
import { assert, tmp, requireFromDesktop } from '../lib.mjs';
import { launchStudio, directorProject, call } from '../swipe-lib.mjs';
import { fixture, groundTruth } from '../lib.mjs';

/** Run a shell snippet exactly as shown, in an isolated HOME so the person's own config is never touched. */
function runShell(snippet, home) {
  return spawnSync('/bin/sh', ['-c', snippet], { cwd: home, env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 120_000 });
}

export default async function () {
  const { app, win } = await launchStudio({ tab: 'edit' });
  try {
    await directorProject(win, groundTruth(), fixture);
    // One click in Settings turns it on.
    await win.click('[data-testid="open-settings"]');
    await win.waitForSelector('[data-testid="mcp-settings"]');
    assert(!(await win.isVisible('[data-testid="setup-tab-claudeCode"]')), 'setup shown before access is on');
    await win.click('[data-testid="mcp-toggle"]');
    await win.waitForSelector('[data-testid="agent-ready"]', { timeout: 15_000 });
    const ready = await win.textContent('[data-testid="agent-ready"]');
    const st = await call(win, 'mcp:status', {});
    assert(st.running && ready.includes(`${st.tools} tools`) && st.mode === 'ask', `ready chip "${ready}", mode ${st.mode}`);
    const snippet = async (tab) => { await win.click(`[data-testid="setup-tab-${tab}"]`); return win.getAttribute(`[data-testid="setup-${tab}"]`, 'data-snippet'); };
    // The token is hidden on screen until asked for, and Copy puts the full snippet on the clipboard.
    await win.click('[data-testid="setup-tab-claudeCode"]');
    const shown = await win.textContent('[data-testid="setup-claudeCode"]');
    assert(!shown.includes(st.token) && shown.includes('••••'), 'token visible by default');
    await app.evaluate(({ clipboard }) => clipboard.writeText('before copy'));
    await win.click('[data-testid="setup-copy"]');
    const cc = await snippet('claudeCode');
    let clip = '';
    for (let i = 0; i < 40 && clip !== cc; i++) { clip = await app.evaluate(({ clipboard }) => clipboard.readText()); if (clip !== cc) await win.waitForTimeout(100); }
    assert(clip === cc && cc.includes(st.token), `Copy did not put the full snippet on the clipboard (got ${JSON.stringify(clip.slice(0, 50))})`);
    // Claude Code: run the command as shown, then ask Claude Code itself whether it can connect.
    const home = tmp('l8.4-claude-home');
    const add = runShell(cc, home);
    assert(add.status === 0, `claude mcp add failed: ${add.stderr || add.stdout}`);
    const list = runShell('claude mcp list', home);
    const line = (list.stdout || '').split('\n').find((l) => l.startsWith('director:')) ?? '';
    assert(/Connected/.test(line) && line.includes(st.url), `claude mcp list: ${list.stdout} ${list.stderr}`);
    // Other MCP apps: the JSON config, used as given by an MCP client.
    const httpCfg = JSON.parse(await snippet('http')).mcpServers.director;
    const { Client } = requireFromDesktop('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = requireFromDesktop('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { StdioClientTransport, getDefaultEnvironment } = requireFromDesktop('@modelcontextprotocol/sdk/client/stdio.js');
    const c1 = new Client({ name: 'cursor', version: '1' });
    await c1.connect(new StreamableHTTPClientTransport(new URL(httpCfg.url), { requestInit: { headers: httpCfg.headers } }));
    const n1 = (await c1.listTools()).tools.length;
    await c1.close();
    // Claude Desktop: the stdio entry, launched as Claude Desktop would.
    const desk = JSON.parse(await snippet('claudeDesktop')).mcpServers.director;
    const c2 = new Client({ name: 'claude-ai', version: '1' });
    await c2.connect(new StdioClientTransport({ command: desk.command, args: desk.args, env: { ...getDefaultEnvironment(), ...desk.env } }));
    const g = JSON.parse((await c2.callTool({ name: 'get_started', arguments: {} })).content[0].text);
    await c2.close();
    // Any AI over HTTP: the curl line as shown.
    const curl = runShell(await snippet('rest'), home);
    const restTools = JSON.parse(curl.stdout).tools;
    assert(n1 === st.tools && g.project?.name && restTools.length === st.tools && restTools[0].input_schema, `http ${n1}, desktop ${g.project?.name}, rest ${restTools?.length}`);
    // Mode choice is one click and sticks.
    await win.click('[data-testid="agent-mode-auto"]');
    await win.waitForFunction(() => document.querySelector('[data-testid="agent-mode-auto"]').checked);
    assert((await call(win, 'mcp:status', {})).mode === 'auto', 'mode did not switch');
    await win.click('[data-testid="agent-mode-ask"]');
    assert((await call(win, 'mcp:status', {})).mode === 'ask', 'mode did not switch back');
    return `one click turned access on (${st.tools} tools, Ask mode); token hidden until shown, Copy copied the full snippet; the Claude Code command ran as shown and \`claude mcp list\` reported "${line.trim().slice(0, 90)}"; the HTTP config (${n1} tools), the Claude Desktop stdio entry (read "${g.project.name}") and the curl line (${restTools.length} tool definitions) each worked as given; the mode switches in one click`;
  } finally { await app.close(); }
}
