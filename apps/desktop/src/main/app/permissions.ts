import { shell, systemPreferences } from 'electron';

export type PermKind = 'camera' | 'microphone' | 'screen';
export type PermState = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

const PANES: Record<PermKind, string> = {
  camera: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Camera',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
};

/**
 * Test runs can pin permission states (DIRECTOR_PERMISSIONS="camera=denied,microphone=not-determined")
 * and change them while running through globalThis.__directorPermissions, since real TCC prompts
 * cannot be driven from automation. Asking for a "not-determined" permission grants it unless the
 * override says "ask-denies".
 */
function overrides(): Record<string, string> | null {
  if (process.env.DIRECTOR_TEST !== '1') return null;
  const g = globalThis as unknown as { __directorPermissions?: Record<string, string> };
  if (!g.__directorPermissions && process.env.DIRECTOR_PERMISSIONS) {
    g.__directorPermissions = Object.fromEntries(process.env.DIRECTOR_PERMISSIONS.split(',').map((p) => p.split('=') as [string, string]));
  }
  return g.__directorPermissions ?? null;
}

export function permissionState(kind: PermKind): PermState {
  const o = overrides();
  if (o?.[kind]) return (o[kind] === 'ask-denies' ? 'not-determined' : o[kind]) as PermState;
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus(kind) as PermState;
}

export async function requestPermission(kind: PermKind): Promise<PermState> {
  const o = overrides();
  if (o?.[kind]) {
    if (o[kind] === 'not-determined') o[kind] = 'granted';
    else if (o[kind] === 'ask-denies') o[kind] = 'denied';
    return permissionState(kind);
  }
  // Screen recording has no prompt API: macOS asks the first time a capture starts.
  if (kind === 'screen' || process.platform !== 'darwin') return permissionState(kind);
  if (permissionState(kind) === 'not-determined') await systemPreferences.askForMediaAccess(kind);
  return permissionState(kind);
}

export const permissionHandlers = {
  'app:permissions': () => ({ camera: permissionState('camera'), microphone: permissionState('microphone'), screen: permissionState('screen') }),
  'app:requestPermission': ({ kind }: { kind: PermKind }) => requestPermission(kind),
  'app:openPrivacySettings': async ({ kind }: { kind: PermKind }) => { await shell.openExternal(PANES[kind]); return true; },
};
