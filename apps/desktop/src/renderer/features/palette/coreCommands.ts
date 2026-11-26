import { WORKSPACES } from '../../shell/workspaces';
import { useShell } from '../../shell/store';
import { invoke } from '../../shell/bridge';
import { registerCommands } from './registry';
import { useProject } from '../project/store';
import { startRecording, stopRecording, openPrompter, closePrompter, setOption, useRecord } from '../record/controller';

const go = (id: (typeof WORKSPACES)[number]['id']) => useShell.getState().setWorkspace(id);
const recording = () => useRecord.getState().phase === 'recording';

/** App-wide commands: workspaces, projects, recording. Feature modules add their own. */
registerCommands([
  ...WORKSPACES.map((w) => ({ id: `go.${w.id}`, title: `Go to ${w.label}`, group: 'Navigate', description: `Open the ${w.label} workspace`, shortcut: `Cmd+${w.shortcut}`, run: () => go(w.id) })),
  { id: 'project.new', title: 'New project', group: 'Project', description: 'Start a new vertical reel project', keywords: 'create', run: async () => {
    const r = await invoke('project:create', { name: 'Untitled reel', preset: 'vertical-1080' });
    await useProject.getState().open(r.dir);
    go('edit');
  } },
  { id: 'project.open', title: 'Open project', group: 'Project', description: 'Open a project folder', run: async () => {
    const [dir] = await invoke('dialog:open', { title: 'Open project', directory: true });
    if (dir) { await useProject.getState().open(dir); go('edit'); }
  } },
  { id: 'record.start', title: 'Start recording', group: 'Record', description: 'Record a take with the prompter', enabled: () => !recording(), run: async () => { go('record'); await startRecording(); } },
  { id: 'record.stop', title: 'Stop recording', group: 'Record', description: 'Stop and save the current take', enabled: recording, run: async () => { await stopRecording(); } },
  { id: 'record.prompter', title: 'Open teleprompter window', group: 'Record', description: 'Show the prompter as an overlay near the camera', run: () => openPrompter() },
  { id: 'record.prompterClose', title: 'Close teleprompter window', group: 'Record', description: 'Hide the prompter window', run: () => closePrompter() },
  { id: 'record.follow', title: 'Prompter follows my voice', group: 'Record', description: 'Scroll by speech recognition', keywords: 'voice follow mode', run: () => setOption('mode', 'follow') },
  { id: 'record.wpm', title: 'Prompter scrolls at a fixed speed', group: 'Record', description: 'Scroll at the words-per-minute rate', keywords: 'wpm speed mode', run: () => setOption('mode', 'wpm') },
]);
