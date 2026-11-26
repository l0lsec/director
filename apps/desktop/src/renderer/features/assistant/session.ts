import { create } from 'zustand';
import { runTurn, stepText, type AssistantMessage, type ToolOutcome, type TurnEvent } from '@director/ai/assistant/index';
import { tools } from '@director/agent';
import { invoke, onEvent } from '../../shell/bridge';
import { useAgent } from '../agent/store';

/** What the chat shows. The API conversation (`messages`) is kept separately and sent as is. */
export interface ChatItem {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'note' | 'error';
  text: string;
  tool?: string;
  status?: 'running' | 'done' | 'applied' | 'rejected' | 'error';
}

interface AssistantState {
  messages: AssistantMessage[];
  items: ChatItem[];
  busy: boolean;
  /** Text Claude is writing right now (streamed), before its step completes. */
  streaming: string;
  costUsd: number;
  draft: string;
  focusTick: number;
}

export const CLIENT = 'Assistant';
/** Tool titles are written for agents; a few read better addressed to the person. */
const CHAT_TITLES: Record<string, string> = { get_state: 'Checked the playhead and selection', get_started: 'Got oriented in the project' };
export const useAssistant = create<AssistantState>(() => ({ messages: [], items: [], busy: false, streaming: '', costUsd: 0, draft: '', focusTick: 0 }));

let controller: AbortController | null = null;
let stepId: string | null = null;
let n = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(n++).toString(36)}`;
const push = (item: ChatItem) => useAssistant.setState((s) => ({ items: [...s.items, item] }));
const patch = (id: string, p: Partial<ChatItem>) => useAssistant.setState((s) => ({ items: s.items.map((x) => (x.id === id ? { ...x, ...p } : x)) }));

onEvent('assistant:text', ({ requestId, delta }) => { if (requestId === stepId) useAssistant.setState((s) => ({ streaming: s.streaming + delta })); });


function outcomeLine(o: ToolOutcome, title: string): { text: string; status: ChatItem['status'] } {
  if (!o.ok) return { text: `${title}: ${o.error.message}`, status: 'error' };
  const d = (o.data ?? {}) as { applied?: boolean; rejected?: boolean; dryRun?: boolean; summary?: unknown; message?: unknown };
  const summary = typeof d.summary === 'string' ? d.summary : '';
  if (d.rejected) return { text: `You rejected: ${summary || title}`, status: 'rejected' };
  if (d.applied === true) return { text: summary || title, status: 'applied' };
  if (d.dryRun) return { text: `Previewed: ${summary || title}`, status: 'done' };
  return { text: title, status: 'done' };
}

const STOPS: Record<string, string> = {
  max_steps: 'Paused after many steps to check in. Say "continue" to keep going.',
  truncated: 'The reply was cut off at the output limit. Say "continue" to pick up from there.',
  cancelled: 'Stopped. Changes already made stay in the project (each one is undoable).',
};

/** Send one message and let Claude work until it answers. */
export async function send(text: string): Promise<void> {
  const t = text.trim();
  if (!t || useAssistant.getState().busy) return;
  controller = new AbortController();
  const signal = controller.signal;
  useAssistant.setState({ busy: true, streaming: '', draft: '' });
  push({ id: uid('u'), kind: 'user', text: t });
  const titles = new Map<string, string>();
  const onEventLocal = (e: TurnEvent) => {
    if (e.type === 'step') {
      const said = stepText(e.content);
      useAssistant.setState({ streaming: '' });
      if (said) push({ id: uid('a'), kind: 'assistant', text: said });
      return;
    }
    if (e.status === 'running') {
      const title = CHAT_TITLES[e.name] ?? tools().get(e.name)?.title ?? e.name;
      titles.set(e.id, title);
      push({ id: e.id, kind: 'tool', tool: e.name, text: title, status: 'running' });
    } else {
      const line = outcomeLine(e.outcome, titles.get(e.id) ?? e.name);
      patch(e.id, line);
    }
  };
  const { runAgentCall } = await import('../agent/host');
  const r = await runTurn({
    messages: useAssistant.getState().messages,
    text: t,
    signal,
    onEvent: onEventLocal,
    send: async (messages) => {
      stepId = uid('step');
      useAssistant.setState({ streaming: '' });
      try { return await invoke('assistant:step', { messages, requestId: stepId }); } finally { stepId = null; }
    },
    runTool: (name, input) => runAgentCall(CLIENT, name, input),
  });
  controller = null;
  useAssistant.setState((s) => ({ messages: r.messages, busy: false, streaming: '', costUsd: s.costUsd + r.costUsd }));
  if (r.redacted) push({ id: uid('n'), kind: 'note', text: 'File paths and file names in your message were left out: they never leave this Mac.' });
  if (r.stop === 'error') push({ id: uid('e'), kind: 'error', text: r.error?.message ?? 'Something went wrong.', ...(r.error?.code ? { tool: r.error.code } : {}) });
  else if (r.stop === 'refusal') push({ id: uid('e'), kind: 'error', text: r.explanation ?? 'Claude declined this request.' });
  else if (STOPS[r.stop]) push({ id: uid('n'), kind: 'note', text: STOPS[r.stop]! });
}

export function stop(): void {
  if (!controller) return;
  controller.abort();
  // A change waiting for approval is answered as rejected, so the assistant stops now rather than after a decision.
  for (const q of useAgent.getState().queue) if (q.client === CLIENT) q.resolve({ ok: false, reason: 'The person stopped the assistant. Nothing changed.' });
  if (stepId) void invoke('assistant:cancel', { requestId: stepId }).catch(() => undefined);
}

export function newChat(): void {
  if (useAssistant.getState().busy) return;
  useAssistant.setState({ messages: [], items: [], streaming: '', costUsd: 0 });
}

(globalThis as Record<string, unknown>).__directorAssistant = {
  send,
  stop,
  newChat,
  state: () => { const s = useAssistant.getState(); return { busy: s.busy, items: s.items, messages: s.messages.length, costUsd: s.costUsd }; },
};
