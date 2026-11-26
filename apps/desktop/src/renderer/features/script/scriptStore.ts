import { create } from 'zustand';
import type { Reference } from '@director/library';
import { useShell } from '../../shell/store';
import { lib, activeBrand } from '../../shell/library';
import { setScript, useRecord } from '../record/controller';

export type AiTab = 'draft' | 'voice' | 'hooks' | 'copy';
interface ScriptUi { scriptId: string | null; draftRefId: string | null; aiTab: AiTab; voiceId: string | null }
export const useScriptUi = create<ScriptUi>(() => ({ scriptId: null, draftRefId: null, aiTab: 'draft', voiceId: null }));

/** From a Swipe reference: open the Script studio with a draft based on it. */
export function openDraftFrom(ref: Reference): void {
  useScriptUi.setState({ draftRefId: ref.id, aiTab: 'draft' });
  useShell.getState().setWorkspace('script');
}

/**
 * Load the latest saved version of a script into the prompter, keeping every cue (the text is
 * passed through unchanged) and the version reference, then switch to Record.
 */
export async function sendToPrompter(scriptId: string, opts: { switchTo?: boolean } = {}): Promise<{ scriptId: string; version: number; cues: number }> {
  const brandId = await activeBrand();
  const s = await lib('studio.script', brandId, scriptId);
  if (!s) throw new Error('Script not found');
  setScript(s.current.text, { scriptId: s.id, version: s.current.n, title: s.title });
  useRecord.setState({ wpm: s.current.wpm });
  if (opts.switchTo !== false) useShell.getState().setWorkspace('record');
  useShell.getState().toast(`"${s.title}" v${s.current.n} is on the prompter`, 'ok');
  return { scriptId: s.id, version: s.current.n, cues: useRecord.getState().script.cues.length };
}

(globalThis as Record<string, unknown>).__directorScript = { sendToPrompter, openDraftFrom, ui: useScriptUi };
