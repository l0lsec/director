import { Suspense, useEffect } from 'react';
import { WORKSPACES, preloadWorkspaces } from './shell/workspaces';
import { useShell } from './shell/store';
import { CommandPalette } from './features/palette/CommandPalette';
import { Toasts } from './shell/Toasts';
import { ContextMenuHost } from './shell/ContextMenu';
import { PromptHost } from './shell/prompt';
import { SettingsModal, openSettings } from './features/settings/SettingsModal';
import { initAgent } from './features/agent/init';
import { AgentApprovals } from './features/agent/AgentApprovals';
import { AgentStatus } from './features/agent/AgentStatus';
import { loadBrands } from './shell/library';
import { Onboarding } from './features/onboarding/Onboarding';
import './features/export/queue';
import './features/script/scriptStore';
import './features/palette/coreCommands';

export function App() {
  const active = useShell((s) => s.workspace);
  const setWorkspace = useShell((s) => s.setWorkspace);
  const projectName = useShell((s) => s.projectName);

  useEffect(() => {
    initAgent();
    void loadBrands();
    // After first paint, so startup stays fast.
    const id = setTimeout(() => void preloadWorkspaces(), 300);
    return () => clearTimeout(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
      if (!e.metaKey || e.shiftKey || e.altKey) return;
      const ws = WORKSPACES.find((w) => w.shortcut === e.key);
      if (ws) {
        e.preventDefault();
        setWorkspace(ws.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setWorkspace]);

  const def = WORKSPACES.find((w) => w.id === active) ?? WORKSPACES[0]!;
  const Active = def.component;
  return (
    <div className="app">
      <header className="topbar">
        <h1 className="brand">DIRECTOR</h1>
        <div role="tablist" aria-label="Workspaces" className="row" style={{ gap: 4 }}>
        {WORKSPACES.map((w) => (
          <button
            key={w.id}
            role="tab"
            className="tab"
            data-testid={`tab-${w.id}`}
            aria-selected={w.id === active}
            title={`${w.label} (Cmd+${w.shortcut})`}
            onClick={() => setWorkspace(w.id)}
          >
            {w.label}
          </button>
        ))}
        </div>
        <span className="spacer" />
        <span className="meta" data-testid="project-name">{projectName ?? 'No project open'}</span>
        <AgentStatus />
        <button className="mini" onClick={openSettings} aria-label="Settings" title="Settings (Cmd+,)" data-testid="open-settings" style={{ marginLeft: 8, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>Settings</button>
      </header>
      <main className="workspace" data-testid={`workspace-${active}`}>
        <Suspense fallback={<div className="empty">Loading</div>}>
          <Active />
        </Suspense>
      </main>
      <CommandPalette />
      <Toasts />
      <ContextMenuHost />
      <PromptHost />
      <SettingsModal />
      <AgentApprovals />
      <Onboarding />
    </div>
  );
}
