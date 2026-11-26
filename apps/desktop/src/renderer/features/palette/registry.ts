export interface Command {
  id: string;
  title: string;
  group: string;
  description: string;
  shortcut?: string;
  keywords?: string;
  enabled?: () => boolean;
  run: () => void | Promise<void>;
}

const commands = new Map<string, Command>();
const listeners = new Set<() => void>();

/** Register commands; returns an unregister function. Re-registering an id replaces it. */
export function registerCommands(list: Command[]): () => void {
  for (const c of list) commands.set(c.id, c);
  listeners.forEach((l) => l());
  return () => { for (const c of list) if (commands.get(c.id) === c) commands.delete(c.id); listeners.forEach((l) => l()); };
}

export function listCommands(): Command[] {
  return [...commands.values()].sort((a, b) => a.group.localeCompare(b.group) || a.title.localeCompare(b.title));
}

export async function runCommand(id: string): Promise<boolean> {
  const c = commands.get(id);
  if (!c || (c.enabled && !c.enabled())) return false;
  await c.run();
  return true;
}

export function onCommandsChanged(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }

// Exposed for automated checks (palette coverage gate).
(globalThis as Record<string, unknown>).__directorCommands = () => listCommands().map(({ id, title, description, shortcut, group, enabled }) => ({ id, title, description, shortcut, group, enabled: enabled ? enabled() : true }));
