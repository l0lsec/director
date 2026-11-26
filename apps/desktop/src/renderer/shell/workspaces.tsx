import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export type WorkspaceId = 'swipe' | 'script' | 'record' | 'edit' | 'export';

export interface WorkspaceDef {
  id: WorkspaceId;
  label: string;
  shortcut: string;
  component: LazyExoticComponent<ComponentType>;
}

const loaders = {
  swipe: () => import('../features/swipe/SwipeWorkspace'),
  script: () => import('../features/script/ScriptWorkspace'),
  record: () => import('../features/record/RecordWorkspace'),
  edit: () => import('../features/edit/EditWorkspace'),
  export: () => import('../features/export/ExportWorkspace'),
} satisfies Record<WorkspaceId, () => Promise<{ default: ComponentType }>>;

// Order follows the real workflow: find a reference, write, record, cut, ship.
export const WORKSPACES: WorkspaceDef[] = [
  { id: 'swipe', label: 'Swipe', shortcut: '1', component: lazy(loaders.swipe) },
  { id: 'script', label: 'Script', shortcut: '2', component: lazy(loaders.script) },
  { id: 'record', label: 'Record', shortcut: '3', component: lazy(loaders.record) },
  { id: 'edit', label: 'Edit', shortcut: '4', component: lazy(loaders.edit) },
  { id: 'export', label: 'Export', shortcut: '5', component: lazy(loaders.export) },
];

/** Load every workspace module in the background so all of their commands are in the palette from the start. */
export function preloadWorkspaces(): Promise<unknown> {
  return Promise.all(Object.values(loaders).map((l) => l().catch(() => undefined)));
}
