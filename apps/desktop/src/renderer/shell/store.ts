import { create } from 'zustand';
import type { WorkspaceId } from './workspaces';

interface Toast { id: number; text: string; tone?: 'ok' | 'error' | 'info' }

interface ShellState {
  workspace: WorkspaceId;
  projectName: string | null;
  /** First-run onboarding is open (null until known): nothing should ask for camera or microphone behind it. */
  onboarding: boolean | null;
  toasts: Toast[];
  setWorkspace: (w: WorkspaceId) => void;
  setProjectName: (n: string | null) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
}

let nextToast = 1;
export const useShell = create<ShellState>((set) => ({
  workspace: 'record',
  projectName: null,
  onboarding: null,
  toasts: [],
  setWorkspace: (workspace) => set({ workspace }),
  setProjectName: (projectName) => set({ projectName }),
  toast: (text, tone = 'info') => {
    const id = nextToast++;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4000);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
