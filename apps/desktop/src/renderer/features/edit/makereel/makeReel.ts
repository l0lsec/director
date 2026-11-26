import { DEFAULT_CAPTIONS } from '@director/analysis';
import { planMakeReel, type MakeReelReport } from '@director/agent/makereel';
import { useProject } from '../../project/store';
import { useShell } from '../../../shell/store';
import { invoke } from '../../../shell/bridge';
export type { MakeReelReport };
export { planMakeReel };
import { ensureTranscripts } from '../transcript/transcripts';
import { registerCommands } from '../../palette/registry';

export async function makeReel(): Promise<MakeReelReport | null> {
  const toast = useShell.getState().toast;
  if (!useProject.getState().doc) return null;
  await ensureTranscripts();
  const doc = useProject.getState().doc!;
  const style = ((await invoke('settings:get', { key: 'captions.style' })) as string | null) ?? DEFAULT_CAPTIONS.styleId;
  const { ops, report } = planMakeReel(doc, style);
  if (!ops.length) { toast('Nothing to change: no speech found', 'info'); return report; }
  useProject.getState().apply(ops, 'Make Reel');
  toast(`Make Reel: ${(report.removedUs / 1e6).toFixed(1)} s removed, ${report.captions} captions, ${report.zooms} zooms${report.missingLines.length ? `, ${report.missingLines.length} script lines not found` : ''}`, 'ok');
  return report;
}

registerCommands([{ id: 'edit.makeReel', title: 'Make Reel', group: 'AI', description: 'Best takes, cut pauses and fillers, captions, zooms', run: async () => { await makeReel(); } }]);
(globalThis as Record<string, unknown>).__directorMakeReel = { makeReel, planMakeReel };
