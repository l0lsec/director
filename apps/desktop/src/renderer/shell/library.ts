import { create } from 'zustand';
import type { Brand } from '@director/library';
import type { LibraryMethod, LibraryResult } from '../../main/library/handlers';
import { invoke, onEvent } from './bridge';

type Args<M extends LibraryMethod> = Parameters<typeof import('../../main/library/handlers').LIBRARY_METHODS[M]> extends [unknown, ...infer R] ? R : never;

/** Typed call into the local library (SQLite in the main process). */
export function lib<M extends LibraryMethod>(method: M, ...args: Args<M>): Promise<LibraryResult<M>> {
  return invoke('library:call', { method, args: args as unknown[] }) as Promise<LibraryResult<M>>;
}

interface BrandState { brands: Brand[]; activeId: string | null; version: number }
export const useBrand = create<BrandState>(() => ({ brands: [], activeId: null, version: 0 }));

/** Bumps whenever library data changes, so views refetch. */
export function libraryChanged(): void { useBrand.setState((s) => ({ version: s.version + 1 })); }

let subscribed = false;
export async function loadBrands(): Promise<string> {
  if (!subscribed) { subscribed = true; onEvent('library:changed', () => libraryChanged()); }
  const brands = await lib('brands.list');
  const saved = (await invoke('settings:get', { key: 'brand.active' })) as string | null;
  const activeId = brands.find((b) => b.id === saved)?.id ?? brands[0]!.id;
  useBrand.setState({ brands, activeId });
  return activeId;
}

export async function setActiveBrand(id: string): Promise<void> {
  useBrand.setState({ activeId: id });
  await invoke('settings:set', { key: 'brand.active', value: id });
  libraryChanged();
}

export async function createBrand(name: string): Promise<void> {
  const b = await lib('brands.create', name);
  useBrand.setState((s) => ({ brands: [...s.brands, b] }));
  await setActiveBrand(b.id);
}

export async function activeBrand(): Promise<string> {
  return useBrand.getState().activeId ?? loadBrands();
}

(globalThis as Record<string, unknown>).__directorLib = { lib, loadBrands, setActiveBrand, createBrand, activeBrand };
