// Typed access to the preload bridge. Channel types come from the IPC contract.
import type { Channel, ChannelInput, ChannelOutput, EventName, EventPayload } from '../../main/ipc/contract';

interface RawBridge {
  invoke: (channel: string, payload?: unknown) => Promise<unknown>;
  on: (event: string, listener: (data: unknown) => void) => () => void;
  pathForFile: (f: File) => string;
  platform: string;
  versions: Record<string, string>;
}

declare global {
  interface Window { director: RawBridge }
}

export function invoke<C extends Channel>(channel: C, payload: ChannelInput<C>): Promise<ChannelOutput<C>> {
  return window.director.invoke(channel, payload).then((res) => {
    const r = res as { ok: boolean; value?: unknown; error?: { code: string; message: string } };
    if (!r.ok) throw Object.assign(new Error(r.error?.message ?? 'IPC error'), { code: r.error?.code });
    return r.value as ChannelOutput<C>;
  });
}

export function onEvent<E extends EventName>(event: E, listener: (data: EventPayload<E>) => void): () => void {
  return window.director.on(event, listener as (d: unknown) => void);
}
