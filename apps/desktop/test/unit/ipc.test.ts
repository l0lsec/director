import { describe, expect, it, vi } from 'vitest';
import { channels } from '../../src/main/ipc/contract';
import { dispatch } from '../../src/main/ipc/dispatch';

const ctx = { senderId: 1 };

describe('IPC dispatch validation', () => {
  it('rejects malformed payloads on every channel before the handler runs', async () => {
    const handlers = Object.fromEntries(Object.keys(channels).map((k) => [k, vi.fn(() => 'reached')]));
    const bad = [42, 'string', [1, 2], { unexpected: true, path: 5 }, { path: '' }, { id: 'not-a-uuid' }, { name: '' }, { dir: 7 }, { projectId: 'p', seq: -1, ops: [] }];
    let rejections = 0;
    for (const channel of Object.keys(channels)) {
      for (const payload of bad) {
        const parsed = (channels as Record<string, { input: { safeParse: (x: unknown) => { success: boolean } } }>)[channel]!.input.safeParse(payload);
        if (parsed.success) continue; // that payload happens to be valid for this channel
        const res = await dispatch(channels, handlers as never, channel, payload, ctx);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error.code).toBe('BAD_INPUT');
        rejections++;
      }
    }
    for (const fn of Object.values(handlers)) expect(fn).not.toHaveBeenCalled();
    expect(rejections).toBeGreaterThan(Object.keys(channels).length * 4);
  });

  it('rejects unknown channels and missing handlers, and passes valid input through', async () => {
    expect((await dispatch(channels, {}, '__proto__', {}, ctx)).ok).toBe(false);
    expect((await dispatch(channels, {}, 'nope:nope', {}, ctx)).ok).toBe(false);
    expect(await dispatch(channels, {}, 'media:probe', { path: '/x' }, ctx)).toMatchObject({ ok: false, error: { code: 'NO_HANDLER' } });
    const handler = vi.fn(async ({ path }: { path: string }) => ({ path }));
    const res = await dispatch(channels, { 'media:probe': handler as never }, 'media:probe', { path: '/x.mp4' }, ctx);
    expect(res).toEqual({ ok: true, value: { path: '/x.mp4' } });
  });

  it('turns handler exceptions into typed errors', async () => {
    const res = await dispatch(channels, { 'media:probe': (() => { throw Object.assign(new Error('boom'), { code: 'X' }); }) as never }, 'media:probe', { path: '/x' }, ctx);
    expect(res).toEqual({ ok: false, error: { code: 'X', message: 'boom' } });
  });
});
