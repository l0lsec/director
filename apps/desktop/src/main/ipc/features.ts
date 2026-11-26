import { projectHandlers } from '../store/handlers';
import { captureHandlers } from '../capture/handlers';
import { mediaHandlers } from '../media/handlers';
import { exportHandlers } from '../export/handlers';
import { transcribeHandlers } from '../transcribe/handlers';
import { audioHandlers } from '../audio/handlers';
import { videoHandlers } from '../video/handlers';
import { libraryHandlers } from '../library/handlers';
import { claudeHandlers } from '../claude/handlers';
import { mcpHandlers } from '../mcp/server';
import { permissionHandlers } from '../app/permissions';
import { getSetting } from '../settings';

// Feature modules contribute IPC handlers here as they land.
export function featureHandlers(): Record<string, unknown> {
  return { ...projectHandlers, ...captureHandlers, ...mediaHandlers, ...exportHandlers, ...transcribeHandlers, ...audioHandlers, ...videoHandlers, ...libraryHandlers, ...claudeHandlers, ...mcpHandlers, ...permissionHandlers,
    // First run only; test runs skip it unless a check asks for it.
    'app:onboarding': () => ({ show: !getSetting<boolean>('onboarding.done', false) && (process.env.DIRECTOR_TEST !== '1' || process.env.DIRECTOR_ONBOARDING === '1') }),
  };
}
