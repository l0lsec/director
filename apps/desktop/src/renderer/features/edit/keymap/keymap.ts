import { runCommand, listCommands } from '../../palette/registry';

export type PresetName = 'capcut' | 'premiere';

/** Shortcut -> command id. Every edit command appears in each preset exactly once. */
export const PRESETS: Record<PresetName, Record<string, string>> = {
  capcut: {
    'Space': 'edit.play', 'Cmd+B': 'edit.split', 'Delete': 'edit.delete', 'Backspace': 'edit.delete', 'Shift+Delete': 'edit.lift',
    'Cmd+Z': 'edit.undo', 'Cmd+Shift+Z': 'edit.redo', 'Cmd+A': 'edit.selectAll', 'Cmd+D': 'edit.duplicate', 'Q': 'edit.trimStart', 'W': 'edit.trimEnd',
    'Alt+Left': 'edit.nudgeLeft', 'Alt+Right': 'edit.nudgeRight', 'Cmd+Shift+D': 'edit.detach', 'M': 'edit.marker', 'T': 'edit.text',
    'A': 'edit.toolSelect', 'B': 'edit.toolBlade', 'Y': 'edit.toolSlip', 'N': 'edit.toolRoll', 'S': 'edit.snap', 'Cmd+R': 'edit.ripple',
    'Cmd+=': 'edit.zoomIn', 'Cmd+-': 'edit.zoomOut', 'Shift+Z': 'edit.zoomFit', 'Up': 'edit.prevEdit', 'Down': 'edit.nextEdit',
    'Left': 'edit.frameBack', 'Right': 'edit.frameForward', 'Home': 'edit.start', 'End': 'edit.end', 'J': 'edit.shuttleBack', 'K': 'edit.shuttleStop', 'L': 'edit.shuttleForward',
    'I': 'edit.inPoint', 'O': 'edit.outPoint', 'Cmd+Shift+X': 'edit.deleteInOut', 'Cmd+L': 'edit.loop', 'Cmd+S': 'edit.save', 'Shift+F': 'edit.freeze', 'Shift+R': 'edit.reverse', 'Cmd+Shift+M': 'edit.makeReel', 'Cmd+Shift+E': 'edit.director',
  },
  premiere: {
    'Space': 'edit.play', 'Cmd+K': 'edit.split', 'Shift+Delete': 'edit.delete', 'Delete': 'edit.lift', 'Backspace': 'edit.lift',
    'Cmd+Z': 'edit.undo', 'Cmd+Shift+Z': 'edit.redo', 'Cmd+A': 'edit.selectAll', 'Cmd+Alt+D': 'edit.duplicate', 'Q': 'edit.trimStart', 'W': 'edit.trimEnd',
    'Alt+Left': 'edit.nudgeLeft', 'Alt+Right': 'edit.nudgeRight', 'Cmd+Shift+D': 'edit.detach', 'M': 'edit.marker', 'Cmd+T': 'edit.text',
    'V': 'edit.toolSelect', 'C': 'edit.toolBlade', 'Y': 'edit.toolSlip', 'N': 'edit.toolRoll', 'S': 'edit.snap', 'Cmd+R': 'edit.ripple',
    '=': 'edit.zoomIn', '-': 'edit.zoomOut', '\\': 'edit.zoomFit', 'Up': 'edit.prevEdit', 'Down': 'edit.nextEdit',
    'Left': 'edit.frameBack', 'Right': 'edit.frameForward', 'Home': 'edit.start', 'End': 'edit.end', 'J': 'edit.shuttleBack', 'K': 'edit.shuttleStop', 'L': 'edit.shuttleForward',
    'I': 'edit.inPoint', 'O': 'edit.outPoint', 'Cmd+Shift+X': 'edit.deleteInOut', 'Cmd+L': 'edit.loop', 'Cmd+S': 'edit.save', 'Shift+F': 'edit.freeze', 'Shift+R': 'edit.reverse', 'Cmd+Shift+M': 'edit.makeReel', 'Cmd+Shift+E': 'edit.director',
  },
};

let preset: PresetName = 'capcut';
export function setPreset(p: PresetName): void { preset = p; }
export function currentPreset(): PresetName { return preset; }

export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey && !(e.key.length === 1 && /[^a-zA-Z0-9]/.test(e.key) && e.key !== ' ')) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.startsWith('Arrow')) k = k.slice(5);
  else if (k === 'Escape') k = 'Esc';
  else if (k.length === 1) k = k.toUpperCase();
  if (e.code === 'Equal') k = '='; else if (e.code === 'Minus') k = '-';
  parts.push(k);
  return parts.join('+');
}

export function shortcutFor(commandId: string): string | undefined {
  return Object.entries(PRESETS[preset]).find(([, id]) => id === commandId)?.[0];
}

/** Handle a keydown in the Edit workspace. Returns true when a command ran. */
export function handleEditKey(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  const combo = comboOf(e);
  const id = PRESETS[preset][combo];
  if (!id) return false;
  e.preventDefault();
  void runCommand(id);
  (globalThis as Record<string, unknown>).__directorLastCommand = id;
  return true;
}

/** Preset sanity for checks: unbound edit commands and duplicate shortcuts. */
export function auditPresets(): Record<PresetName, { unbound: string[]; duplicates: string[] }> {
  const ids = listCommands().filter((c) => c.id.startsWith('edit.')).map((c) => c.id);
  const out = {} as Record<PresetName, { unbound: string[]; duplicates: string[] }>;
  for (const name of Object.keys(PRESETS) as PresetName[]) {
    const map = PRESETS[name];
    const bound = new Set(Object.values(map));
    const keys = Object.keys(map);
    out[name] = { unbound: ids.filter((id) => !bound.has(id)), duplicates: keys.filter((k, i) => keys.indexOf(k) !== i) };
  }
  return out;
}
(globalThis as Record<string, unknown>).__directorKeymap = { auditPresets, setPreset, PRESETS };
