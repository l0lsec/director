import { runJobOk } from './runner';
import { requireSidecar } from './sidecars';
import type { NativeDevice } from '../ipc/contract';

/** Runs a one-shot director-native subcommand and returns its JSON-lines output parsed. */
export async function nativeCall<T = unknown>(args: string[], input?: string): Promise<T[]> {
  const res = await runJobOk({ kind: `native:${args[0]}`, cmd: requireSidecar('director-native'), args, input });
  return res.stdout.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
}

export async function nativeVersion(): Promise<{ name: string; version: string; protocol: number; macos: string }> {
  const [v] = await nativeCall<{ name: string; version: string; protocol: number; macos: string }>(['version']);
  if (!v) throw new Error('director-native returned nothing');
  return v;
}

export async function nativeDevices(): Promise<NativeDevice[]> {
  return nativeCall<NativeDevice>(['devices']);
}
