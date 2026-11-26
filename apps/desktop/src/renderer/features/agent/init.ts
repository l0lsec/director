import type { ToolResponse } from '@director/agent';
import { invoke, onEvent } from '../../shell/bridge';
import { useAgent } from './store';

/** The tool host is loaded on the first agent call, so app startup stays fast. */
const host = () => import('./host');

async function run(client: string, tool: string, args: unknown): Promise<ToolResponse> {
  const { runAgentCall } = await host();
  return runAgentCall(client, tool, args);
}

/** Wire agent calls from main and keep the status fresh. */
export function initAgent(): void {
  void invoke('mcp:status', {}).then((s) => useAgent.setState({ status: s }));
  onEvent('mcp:status', (s) => useAgent.setState({ status: s }));
  onEvent('agent:call', ({ requestId, client, tool, args }) => {
    void run(client, tool, args)
      .catch((e: Error): ToolResponse => ({ ok: false, error: { code: 'FAILED', message: e.message } }))
      .then((response) => {
        const r: ToolResponse = response.ok ? response : { ok: false, error: { code: response.error.code.slice(0, 64), message: response.error.message.slice(0, 20_000), ...(response.error.hint ? { hint: response.error.hint.slice(0, 2000) } : {}) } };
        return invoke('agent:result', { requestId, response: r });
      })
      .catch(() => undefined);
  });
}

(globalThis as Record<string, unknown>).__directorAgent = {
  run: (tool: string, args: unknown, client = 'Test agent') => run(client, tool, args),
  state: () => { const s = useAgent.getState(); return { status: s.status, activity: s.activity, queue: s.queue.map(({ resolve: _r, ...q }) => q) }; },
  decide: (ok: boolean) => useAgent.getState().queue[0]?.resolve({ ok }),
  revert: async () => (await host()).revertAgentChanges(),
};
