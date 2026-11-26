import { app } from 'electron';
import { join } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { newProject, CANVAS_PRESETS, COMMON_FPS, type Project } from '@director/engine';
import { createProjectBundle, listProjects, openProjectBundle, ProjectSession } from './projectStore';

const sessions = new Map<string, ProjectSession>();

export function projectsRoot(): string {
  const dir = process.env.DIRECTOR_PROJECTS_DIR ?? join(app.getPath('documents'), 'Director Projects');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled';
}

export function sessionFor(projectId: string): ProjectSession {
  const s = sessions.get(projectId);
  if (!s) throw Object.assign(new Error('Project is not open'), { code: 'NOT_OPEN' });
  return s;
}

export function openSession(dir: string): { doc: Project; seq: number; recoveredOps: number; migratedFrom: number | null; dir: string } {
  for (const s of sessions.values()) if (s.dir === dir) return { doc: s.doc, seq: s.seq, recoveredOps: 0, migratedFrom: null, dir };
  const opened = openProjectBundle(dir);
  const session = new ProjectSession(dir, opened);
  sessions.set(session.id, session);
  return { doc: session.doc, seq: session.seq, recoveredOps: opened.recoveredOps, migratedFrom: opened.migratedFrom, dir };
}

export function createSession(input: { name: string; preset?: string; fps?: string; parentDir?: string }): ReturnType<typeof openSession> {
  const parent = input.parentDir ?? projectsRoot();
  let dir = join(parent, `${safeName(input.name)}.director`);
  for (let i = 2; existsSync(dir); i++) dir = join(parent, `${safeName(input.name)} ${i}.director`);
  const preset = CANVAS_PRESETS[input.preset ?? 'vertical-1080'] ?? CANVAS_PRESETS['vertical-1080']!;
  const fps = COMMON_FPS[input.fps ?? '30'] ?? { num: 30, den: 1 };
  const doc = newProject({ name: input.name, canvas: { ...preset, fps } });
  createProjectBundle(dir, doc);
  return openSession(dir);
}

export function closeAllSessions(): void {
  for (const s of sessions.values()) { try { s.close(); } catch { /* best effort on quit */ } }
  sessions.clear();
}

export const projectHandlers = {
  'project:create': (i: { name: string; preset?: string; fps?: string; parentDir?: string }) => createSession(i),
  'project:open': (i: { dir: string }) => openSession(i.dir),
  'project:journal': (i: { projectId: string; seq: number; ops: unknown[] }) => sessionFor(i.projectId).journal(i.ops as never, i.seq),
  'project:save': (i: { projectId: string }) => { const s = sessionFor(i.projectId); s.snapshot(); return { seq: s.seq }; },
  'project:close': (i: { projectId: string }) => { const s = sessions.get(i.projectId); if (s) { s.close(); sessions.delete(i.projectId); } return true; },
  'project:list': () => listProjects(projectsRoot()),
  'project:dir': (i: { projectId: string }) => sessionFor(i.projectId).dir,
};
