import { statSync, readFileSync, writeFileSync, readdirSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { assert, root, tmp, fixture } from '../lib.mjs';
import { agentSession, tool, must, appDoc } from '../agent-lib.mjs';

/** IPC channels the agent host may use, reviewed: none of them deletes or moves files. */
const REVIEWED = new Set(['media:import', 'export:defaultDir', 'file:exists', 'file:writeText', 'file:writeImage', 'project:list', 'project:create', 'take:list', 'settings:get', 'settings:set', 'audiolib:scan', 'agent:result', 'agent:setMode', 'mcp:status']);
const DELETING = /delete|remove|trash|unlink|rm\b|rename|move/i;

function channelsUsed(text) { return [...text.matchAll(/invoke\('([a-z]+:[a-zA-Z]+)'/g)].map((m) => m[1]); }

export default async function () {
  // Static: the agent host reaches the main process only through reviewed channels, none of which deletes files,
  // and no catalog tool is about deleting files. Positive control: the scanner does see a deleting channel.
  const sources = ['host.ts', 'init.ts', 'AgentApprovals.tsx', 'AgentPanel.tsx'].map((f) => readFileSync(join(root, 'apps/desktop/src/renderer/features/agent', f), 'utf8')).join('\n');
  const used = [...new Set(channelsUsed(sources))];
  assert(channelsUsed("invoke('file:delete', {})").join() === 'file:delete' && DELETING.test('file:delete'), 'scanner control failed');
  const unreviewed = used.filter((c) => !REVIEWED.has(c));
  assert(!unreviewed.length, `agent host uses unreviewed channels: ${unreviewed.join()}`);
  assert(![...REVIEWED].some((c) => DELETING.test(c)), 'a reviewed channel deletes files');
  const s = await agentSession({ mode: 'auto' });
  const { client, win } = s;
  try {
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert(!names.some((n) => /(delete|remove|trash)_(file|media_file|project)|^rm_/.test(n)), `a tool deletes files: ${names.filter((n) => /file/.test(n))}`);
    // Exports stay in the export folder.
    const outsideTries = [
      ['export_video', { fileName: '../escape.mp4' }], ['export_video', { fileName: '/tmp/escape.mp4' }], ['export_video', { fileName: '.hidden.mp4' }],
      ['export_subtitles', { format: 'srt', fileName: 'sub/escape.srt' }], ['export_subtitles', { format: 'srt', fileName: '..\\escape.srt' }],
      ['export_still', { t: 1, fileName: '../../escape.png' }], ['export_video', { fileName: 'clip.mov' }],
    ];
    for (const [t, a] of outsideTries) {
      const r = await tool(client, t, a);
      assert(r.error && /plain file name|must end in/.test(r.error), `${t} ${JSON.stringify(a)} was not refused: ${JSON.stringify(r).slice(0, 200)}`);
    }
    // Positive control: a legal name lands inside the export folder.
    await must(client, 'generate_captions', {});
    const sub = await must(client, 'export_subtitles', { format: 'vtt', fileName: 'captions.vtt' });
    assert(existsSync(join(s.exportDir, sub.file)) && readFileSync(join(s.exportDir, sub.file), 'utf8').startsWith('WEBVTT'), 'subtitle file not in the export folder');
    const still = await must(client, 'export_still', { t: 1, fileName: 'cover.png' });
    assert(existsSync(join(s.exportDir, still.file)), 'still not in the export folder');
    const again = await must(client, 'export_still', { t: 1, fileName: 'cover.png' });
    assert(again.file === 'cover (2).png' && readdirSync(s.exportDir).length === 3, `an existing export was overwritten: ${again.file}`);
    // Imports take existing media files only.
    const work = tmp('l8.2-security-import');
    const txt = join(work, 'notes.txt');
    writeFileSync(txt, 'not media');
    const fakeVideo = join(work, 'fake.mp4');
    writeFileSync(fakeVideo, 'not really a video');
    const before = Object.keys((await appDoc(win)).media).length;
    const imp = await must(client, 'import_media', { paths: [txt, fakeVideo, join(work, 'missing.mov'), fixture('still.png')] });
    assert(imp.added.length === 1 && imp.added[0].name === 'still.png' && imp.failed.length === 3, `import: ${JSON.stringify(imp).slice(0, 300)}`);
    assert(Object.keys((await appDoc(win)).media).length === before + 1, 'refused files reached the project');
    const rel = await tool(client, 'import_media', { paths: ['relative/clip.mp4'] });
    assert(rel.error && /absolute path/.test(rel.error), 'relative import path accepted');
    // The connection file is private and carries no secret.
    const file = s.status.connectionFile;
    const mode = statSync(file).mode & 0o777;
    const content = readFileSync(file, 'utf8');
    assert(mode === 0o600, `connection file mode ${mode.toString(8)}`);
    assert(!content.includes(s.token) && JSON.parse(content).url.startsWith('http://127.0.0.1:'), 'connection file content');
    assert(realpathSync(file).startsWith(realpathSync(s.userData)), 'connection file outside user data');
    return `agent host uses ${used.length} reviewed channels (none deletes files) and no tool deletes files; ${outsideTries.length} attempts to write outside the export folder were refused while legal names landed inside it (and never overwrote); import took the one real media file and refused a text file, a fake video and a missing path; the connection file is 0600 with no token`;
  } finally { await s.close(); }
}
