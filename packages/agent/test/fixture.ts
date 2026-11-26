import { History, newClip, newLane, newProject, defaultAudio, makeTemplate, uid, type Clip, type MediaRef, type Op, type Project, type Template } from '@director/engine';
import type { AgentContext, AgentHost, Approval, ApprovalRequest } from '../src';

const S = 1_000_000;
const media = (id: string, name: string, kind: MediaRef['kind'], dur: number, extra: Partial<MediaRef> = {}): MediaRef => ({
  id, path: `/fixtures/${name}`, hash: `hash_${id}`.padEnd(16, '0'), name, kind, durationUs: dur * S, hasAudio: kind !== 'image', hasVideo: kind !== 'audio', addedAt: '2026-11-25T00:00:00.000Z',
  ...(kind !== 'audio' ? { width: 1920, height: 1080, fps: { num: 30, den: 1 } } : {}), ...extra,
});

/** Spoken words for media_1, aligned with its source time (seconds). */
export const SPEECH = 'Stop typing plain prompts . um so here is the trick you know . give Claude a role and a goal . then show it one example . link in bio . follow for part two'.split(' ').filter((w) => w !== '.');

export function buildFixture(): Project {
  const doc = newProject({ name: 'Fixture reel', id: 'proj_fixture', now: '2026-11-25T00:00:00.000Z' });
  doc.lanes = doc.lanes.map((l) => ({ ...l, id: `lane_${l.kind}` }));
  doc.lanes.splice(4, 0, newLane('broll', { id: 'lane_123', name: 'B-roll 2' }));
  doc.media = {
    media_1: media('media_1', 'camera.mp4', 'video', 20, { role: 'camera' }),
    media_2: media('media_2', 'broll.mp4', 'video', 15, { role: 'broll', hasAudio: false }),
    media_music: media('media_music', 'music.wav', 'audio', 60, { role: 'music' }),
    media_img: media('media_img', 'logo.png', 'image', 0, { role: 'image', hasAudio: false }),
    media_screen: media('media_screen', 'screen.mp4', 'video', 30, { role: 'screen', hasAudio: false }),
    media_vo: media('media_vo', 'interview.mp4', 'video', 30, { role: 'other' }),
  };
  const lane = (k: string) => doc.lanes.find((l) => l.id === `lane_${k}`)!;
  const cam = (id: string, from: number, to: number, extra: Partial<Clip> = {}) => newClip({ id, kind: 'media', mediaId: 'media_1', start: from * S, in: from * S, out: to * S, name: id, audio: defaultAudio(), ...extra });
  lane('camera').clips.push(
    cam('clip_abc', 0, 6, { effects: [{ id: 'fx_123', type: 'color', enabled: true, params: { exposure: 0, contrast: 0.1, saturation: 0, temperature: 0, tint: 0, brightness: 0 } }] }),
    cam('clip_a', 6, 9), cam('clip_b', 9, 12), cam('clip_c', 12, 16), cam('clip_camera', 16, 20),
  );
  lane('screen').clips.push(newClip({ id: 'clip_screen', kind: 'media', mediaId: 'media_screen', start: 0, in: 0, out: 5 * S, fit: 'contain' }));
  lane('broll').clips.push(
    newClip({ id: 'clip_broll', kind: 'media', mediaId: 'media_2', start: 2 * S, in: 0, out: 3 * S }),
    newClip({ id: 'clip_graded', kind: 'media', mediaId: 'media_2', start: 10 * S, in: 5 * S, out: 7 * S, effects: [{ id: 'fx_g1', type: 'color', enabled: true, params: { exposure: 0.2, contrast: 0.2, saturation: 0.1, temperature: 0.1, tint: 0, brightness: 0 } }, { id: 'fx_g2', type: 'vignette', enabled: true, params: { amount: 0.3 } }] }),
    newClip({ id: 'clip_video', kind: 'media', mediaId: 'media_vo', start: 13 * S, in: 0, out: 2 * S, audio: { ...defaultAudio(), muted: true }, linkGroup: 'link_va' }),
  );
  lane('voice').clips.push(newClip({ id: 'clip_audio', kind: 'media', mediaId: 'media_vo', start: 13 * S, in: 0, out: 2 * S, audio: defaultAudio(), linkGroup: 'link_va' }));
  lane('music').clips.push(newClip({ id: 'clip_music', kind: 'media', mediaId: 'media_music', start: 0, in: 0, out: 20 * S, audio: { ...defaultAudio(), gainDb: { value: -12 } } }));
  lane('titles').clips.push(newClip({ id: 'clip_title', kind: 'text', start: 0.5 * S, in: 0, out: 2.5 * S, text: { content: 'Stop typing plain prompts', font: 'Inter', size: 96, weight: 900, color: '#ffffff', align: 'center', lineHeight: 1.05, maxWidth: 0.86 } }));
  lane('graphics').clips.push(
    newClip({ id: 'clip_bar', kind: 'shape', start: 4 * S, in: 0, out: 2 * S, shape: { type: 'rect', color: '#000000', radius: 8 } }),
    newClip({ id: 'clip_face', kind: 'media', mediaId: 'media_1', start: 7 * S, in: 0, out: 2 * S }),
  );
  doc.markers = [{ id: 'mk_123', t: 5 * S, kind: 'note', label: 'Check this' }];
  // Two words a second, with a pause after each sentence.
  const words: Array<{ text: string; start: number; end: number }> = [];
  let t = 0.3;
  for (const w of SPEECH) {
    words.push({ text: w, start: Math.round(t * S), end: Math.round((t + 0.32) * S) });
    t += 0.4;
    if (['prompts', 'know', 'goal', 'example', 'bio'].includes(w)) t += 0.9;
  }
  doc.transcript = [{ mediaId: 'media_1', language: 'en', words }];
  return doc;
}

export function fixtureTemplates(doc: Project): Template[] {
  const t = makeTemplate(doc, ['clip_title', 'clip_bar'], 'Lower third');
  return [{ ...t, id: 'tpl_lower' }];
}

export interface TestCtx extends AgentContext { history: History; approvals: ApprovalRequest[]; decide: (r: ApprovalRequest) => Approval; agentEntries: number }

/** A context with a real undo history and an in-memory host, for unit tests. */
export function makeCtx(doc: Project = buildFixture(), opts: { approve?: (r: ApprovalRequest) => Approval } = {}): TestCtx {
  const history = new History(doc);
  let rev = 0;
  let selection: string[] = [];
  let playhead = 0;
  let templates = fixtureTemplates(doc);
  const exports: ReturnType<AgentHost['exportJobs']> = [];
  const files = new Map<string, string | Uint8Array>();
  const host: Partial<AgentHost> = {
    info: () => ({ app: 'Director', version: 'test', mode: 'auto', projectDir: '/fixtures/project', workspace: 'edit' }),
    state: () => ({ playhead, playing: false, selection, inPoint: null, outPoint: null, workspace: 'edit' }),
    history: () => ({ undo: [], redo: [], agentSteps: 0 }),
    undo: (n) => { let k = 0; while (k < n && history.undo()) k++; rev++; return k; },
    redo: (n) => { let k = 0; while (k < n && history.redo()) k++; rev++; return k; },
    revertAgentChanges: () => ({ reverted: 0 }),
    seek: (t) => { playhead = t; },
    pause: () => undefined,
    play: async () => undefined,
    select: (ids) => { selection = ids; },
    showWorkspace: () => undefined,
    listTakes: async () => [{ id: 'take_1', title: 'Take 1', dir: '/fixtures/takes/take_1', createdAt: '2026-11-25T10:00:00Z', durationUs: 30 * S, rating: 4, markers: 2, hasScreen: false, hasScript: true }],
    addTake: async () => { history.apply([{ op: 'addClip', laneId: 'lane_camera', clip: newClip({ id: 'clip_take', kind: 'media', mediaId: 'media_1', start: 20 * S, in: 0, out: 5 * S, audio: defaultAudio() }) }], 'Add take'); rev++; return true; },
    templates: async () => templates,
    saveTemplates: async (t) => { templates = t; ctx.env.templates = t; },
    renderFrame: async (_t, w) => ({ png: new Uint8Array([137, 80, 78, 71]), width: w, height: Math.round((w * 16) / 9) }),
    contactSheet: async (times, w) => ({ png: new Uint8Array([137, 80, 78, 71, times.length]), width: w, height: w }),
    exportVideo: async (o) => { const j = { id: `exp_${exports.length + 1}`, status: 'queued', progress: 0, path: `/exports/${o.fileName ?? 'Fixture reel.mp4'}` }; exports.push(j); return { jobId: j.id, path: j.path }; },
    exportJobs: () => exports,
    cancelExport: async (id) => exports.some((j) => j.id === id),
    writeExportFile: async (name, _k, data) => { files.set(name, data); return `/exports/${name}`; },
    exportDir: async () => '/exports',
    save: async () => undefined,
    listProjects: async () => [{ dir: '/fixtures/project', name: 'Fixture reel', updatedAt: '2026-11-25' }, { dir: '/fixtures/prompting', name: 'Prompting reel', updatedAt: '2026-11-24' }],
    openProject: async () => history.doc,
    createProject: async (name) => { const d = { ...buildFixture(), name }; history.reset(d); rev++; return d; },
    audioLibrary: async () => [{ path: '/music/upbeat.mp3', name: 'upbeat', folder: '/music', durationUs: 90 * S, kind: 'music' }],
    activeBrand: () => 'brand_1',
    library: async (method: string, ...args: unknown[]) => {
      if (method === 'swipe.list') return [{ id: 'ref_123', title: 'Reference', views: 1000, likes: 50, tags: [], durationUs: 30 * S, analysis: { pacing: { durationSec: 30, shotCount: 12, avgShotSec: 2.5, medianShotSec: 2.4, longestShotSec: 4, cutsPerMin: 22, firstCutSec: 1.1, wordCount: 80, wordsPerSec: 2.7, wpm: 160, speechRatio: 0.85 } } }];
      if (method === 'swipe.get') return args[1] === 'ref_123' ? { id: 'ref_123', title: 'Reference', path: '/secret/ref.mp4', analysis: { pacing: { durationSec: 30, shotCount: 12, avgShotSec: 2.5, medianShotSec: 2.4, longestShotSec: 4, cutsPerMin: 22, firstCutSec: 1.1, wordCount: 80, wordsPerSec: 2.7, wpm: 160, speechRatio: 0.85 } } } : null;
      if (method === 'swipe.transcript') return null;
      if (method === 'studio.scripts') return [{ id: 'scr_123', title: 'Prompting', versions: 2, current: { n: 2, text: 'Stop typing plain prompts.\n[ZOOM]\nGive Claude a role and a goal.', wpm: 160, targetSec: 30 } }];
      if (method === 'studio.script') return args[1] === 'scr_123' ? { id: 'scr_123', title: 'Prompting', current: { n: 2, text: 'Stop typing plain prompts.\n[ZOOM]\nGive Claude a role and a goal.', wpm: 160, targetSec: 30 } } : null;
      if (method === 'studio.versions') return [{ n: 1, text: 'Stop typing plain prompts.', wpm: 150, targetSec: 30 }, { n: 2, text: 'Stop typing plain prompts.\n[ZOOM]\nGive Claude a role and a goal.', wpm: 160, targetSec: 30 }];
      throw new Error(`fake library: ${method}`);
    },
    // A content folder opened in the Files panel: category folders with a few files.
    fileRoots: async () => ({ roots: ['/Users/me/Content'], current: '/Users/me/Content' }),
    listFolder: async (dir) => {
      const f = (rel: string, type: 'dir' | 'video' | 'audio' | 'image', size = 0) => ({ name: rel.split('/').pop()!, path: `/Users/me/Content/${rel}`, rel, type, size, mtimeMs: 0 });
      if (dir === '/Users/me/Content') return { dir, entries: [f('B-Roll', 'dir'), f('Music', 'dir'), f('SFX', 'dir')], skipped: 1 };
      if (dir === '/Users/me/Content/SFX') return { dir, entries: [f('SFX/whoosh.wav', 'audio', 120_000)], skipped: 0 };
      throw Object.assign(new Error(`${dir} does not exist`), { code: 'NOT_FOUND' });
    },
    searchFolder: async (_dir, query) => ({ results: 'whoosh'.includes(query.toLowerCase()) ? [{ name: 'whoosh.wav', path: '/Users/me/Content/SFX/whoosh.wav', rel: 'SFX/whoosh.wav', type: 'audio' as const, size: 120_000, mtimeMs: 0 }] : [], truncated: false }),
    importMedia: async (paths, role) => {
      const added = paths.map((p, i) => media(`media_new${i}`, p.split('/').pop()!, /\.(wav|mp3|m4a)$/i.test(p) ? 'audio' : /\.(png|jpe?g)$/i.test(p) ? 'image' : 'video', 10, { role, path: p }));
      const ops: Op[] = added.filter((m) => !history.doc.media[m.id]).map((m) => ({ op: 'addMedia', media: m }));
      if (ops.length) { history.apply(ops, 'Import'); rev++; }
      return { added, existing: [], failed: [] };
    },
    transcribe: async () => [{ mediaId: 'media_1', words: SPEECH.length, language: 'en' }],
    processAudio: async () => true,
    detectBeats: async () => { history.apply([0.5, 1, 1.5].map((s) => ({ op: 'addMarker', marker: { id: uid('beat'), t: s * S, kind: 'beat', label: 'Beat' } })), 'Beats'); rev++; return 3; },
    autoReframe: async () => true,
    detectSpeakers: async () => ({ people: 2, panels: [{ x: 0, y: 0.25, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.25, w: 0.5, h: 0.5 }], talkSeconds: [4, 9], confidence: 0.9, turns: 3, sampleTurns: [{ person: 1, start: 0, end: 4e6, text: 'hello there' }] }),
    speakerLayout: async (_id, o) => ({ people: 2, panels: [{ x: 0, y: 0.25, w: 0.5, h: 0.5 }, { x: 0.5, y: 0.25, w: 0.5, h: 0.5 }], talkSeconds: [4, 9], confidence: 0.9, turns: 3, sampleTurns: [], shots: 5, closeShots: 4, sideBySide: 1, clips: 6, applied: !o.dryRun }),
    removeBackground: async () => true,
    stabilize: async () => true,
  };
  const ctx: TestCtx = {
    client: 'Test agent',
    history,
    approvals: [],
    agentEntries: 0,
    decide: opts.approve ?? (() => ({ ok: true })),
    getDoc: () => history.doc,
    revision: () => rev,
    apply(ops, label) { history.apply(ops, label); rev++; ctx.agentEntries++; return rev; },
    async approve(r) { ctx.approvals.push(r); return ctx.decide(r); },
    env: { templates, fileExists: (p) => p.startsWith('/fixtures/') || p.startsWith('/luts/') },
    host,
  };
  return ctx;
}
