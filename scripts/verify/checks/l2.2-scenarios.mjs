import { assert } from '../lib.mjs';
import { launchEditor, importFixtures } from '../edit-lib.mjs';

const S = 1_000_000;

export default async function () {
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    await win.setViewportSize({ width: 1600, height: 1000 }).catch(() => {});
    const [sync, speech] = await importFixtures(win, ['sync-1080p30.mp4', 'speech.wav']);
    // Baseline timeline built from ops: A [0,4) and B [4,8) on Camera, voice V [0,4) linked to A, title T [5,7).
    await win.evaluate(({ sync, speech, S }) => {
      const d = globalThis.__directorProject().doc;
      const lane = (k) => d.lanes.find((l) => l.kind === k).id;
      const base = { speed: { kind: 'constant', rate: 1, preservePitch: true }, reverse: false, transform: { x: { value: 0 }, y: { value: 0 }, scale: { value: 1 }, rotation: { value: 0 }, opacity: { value: 1 }, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false }, blend: 'normal', effects: [], enabled: true };
      const audio = { gainDb: { value: 0 }, pan: 0, fadeIn: 0, fadeOut: 0, muted: false, duckable: false };
      globalThis.__directorProjectApply([
        { op: 'addClip', laneId: lane('camera'), clip: { ...base, id: 'A', kind: 'media', mediaId: sync, start: 0, in: 0, out: 4 * S, linkGroup: 'L1', audio: { ...audio, muted: true } } },
        { op: 'addClip', laneId: lane('camera'), clip: { ...base, id: 'B', kind: 'media', mediaId: sync, start: 4 * S, in: 5 * S, out: 9 * S, audio } },
        { op: 'addClip', laneId: lane('voice'), clip: { ...base, id: 'V', kind: 'media', mediaId: speech, start: 0, in: 0, out: 4 * S, linkGroup: 'L1', audio } },
        { op: 'addClip', laneId: lane('titles'), clip: { ...base, id: 'T', kind: 'text', start: 5 * S, in: 0, out: 2 * S, text: { content: 'Title', font: 'Inter', size: 80, weight: 800, color: '#fff', align: 'center', lineHeight: 1.1, maxWidth: 0.8 } } },
      ], 'baseline');
      globalThis.__directorEditCmd.setEdit({ zoom: 100, scrollX: 0, ripple: true, snapping: true, tool: 'select', selection: [] });
      globalThis.__directorEditCmd.seek(0);
    }, { sync, speech, S });
    await win.waitForTimeout(300);
    const baseline = await win.evaluate(() => JSON.stringify(globalThis.__directorProject().doc.lanes));
    const doc = () => win.evaluate(() => globalThis.__directorProject().doc);
    const clip = async (id) => (await doc()).lanes.flatMap((l) => l.clips.map((c) => ({ ...c, lane: l.kind }))).find((c) => c.id === id);
    const clipsOn = async (kind) => (await doc()).lanes.find((l) => l.kind === kind).clips;
    const rect = (id) => win.evaluate((i) => globalThis.__directorTimeline.clipRect(i), id);
    const xAt = (t) => win.evaluate((tt) => globalThis.__directorTimeline.timeToClientX(tt), t);
    const laneY = (k) => win.evaluate((kk) => globalThis.__directorTimeline.laneCenterY(kk), k);
    const edit = (patch) => win.evaluate((p) => globalThis.__directorEditCmd.setEdit(p), patch);
    const sel = () => win.evaluate(() => globalThis.__directorEditCmd.getEdit().selection);
    const drag = async (x0, y0, x1, y1) => { await win.mouse.move(x0, y0); await win.mouse.down(); await win.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 4 }); await win.mouse.move(x1, y1, { steps: 6 }); await win.mouse.up(); await win.waitForTimeout(60); };
    const click = async (x, y, mods = []) => { for (const m of mods) await win.keyboard.down(m); await win.mouse.click(x, y); for (const m of mods) await win.keyboard.up(m); await win.waitForTimeout(40); };
    const key = async (k) => { await win.keyboard.press(k); await win.waitForTimeout(60); };
    const reset = async () => {
      for (let i = 0; i < 50; i++) {
        const cur = await win.evaluate(() => JSON.stringify(globalThis.__directorProject().doc.lanes));
        if (cur === baseline) break;
        await win.evaluate(() => globalThis.__directorUndo());
      }
      const now = await win.evaluate(() => JSON.stringify(globalThis.__directorProject().doc.lanes));
      assert(now === baseline, 'undo returned to the baseline');
      await edit({ ripple: true, snapping: true, tool: 'select', selection: [], inPoint: null, outPoint: null });
      await win.evaluate(() => globalThis.__directorEditCmd.seek(0));
    };
    const results = [];
    const scenario = async (name, fn) => {
      try { await fn(); results.push({ name, ok: true }); }
      catch (e) { results.push({ name, ok: false, err: String(e.message ?? e).slice(0, 200) }); }
      await reset();
    };
    const mid = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

    await scenario('click selects a clip', async () => { const r = mid(await rect('A')); await click(r.x, r.y); assert(JSON.stringify(await sel()) === '["A"]', `sel ${await sel()}`); });
    await scenario('shift-click adds to the selection', async () => { await click(mid(await rect('A')).x, mid(await rect('A')).y); await click(mid(await rect('B')).x, mid(await rect('B')).y, ['Shift']); assert((await sel()).sort().join() === 'A,B', `sel ${await sel()}`); });
    await scenario('click on empty lane clears the selection', async () => { await click(mid(await rect('A')).x, mid(await rect('A')).y); await click(await xAt(8.6 * S), await laneY('camera')); assert((await sel()).length === 0, `still selected ${await sel()}`); });
    await scenario('drag moves a clip and overwrites what it lands on', async () => { const r = await rect('A'); await drag(r.x + 60, r.y + r.h / 2, r.x + 60 + 100, r.y + r.h / 2); const a = await clip('A'); const b = await clip('B'); assert(Math.abs(a.start - S) < 0.05 * S, `A.start ${a.start}`); assert(Math.abs(b.start - 5 * S) < 0.05 * S, `B.start ${b.start}`); });
    await scenario('dragging a clip carries its linked voice', async () => { const r = await rect('A'); await edit({ snapping: false }); await drag(r.x + 60, r.y + r.h / 2, r.x + 60 + 250, r.y + r.h / 2); const a = await clip('A'); const v = await clip('V'); assert(a.start === v.start && a.start > 2 * S, `A ${a.start} V ${v.start}`); });
    await scenario('drag to another lane', async () => { const r = await rect('B'); await drag(r.x + 80, r.y + r.h / 2, r.x + 80, await laneY('broll')); const b = await clip('B'); assert(b.lane === 'broll', `lane ${b.lane}`); assert(Math.abs(b.start - 4 * S) < 0.05 * S, `start ${b.start}`); });
    await scenario('snapping pulls a moved clip onto an edge', async () => { const r = await rect('T'); await drag(r.x + 40, r.y + r.h / 2, r.x + 40 - 95, r.y + r.h / 2); const t = await clip('T'); assert(t.start === 4 * S, `T.start ${t.start}`); });
    await scenario('snapping off leaves the exact drop position', async () => { await edit({ snapping: false }); const r = await rect('T'); await drag(r.x + 40, r.y + r.h / 2, r.x + 40 - 96, r.y + r.h / 2); const t = await clip('T'); assert(t.start !== 4 * S && Math.abs(t.start - 4.04 * S) < 0.03 * S, `T.start ${t.start}`); });
    await scenario('ripple trim of an end edge pulls later clips', async () => { const r = await rect('A'); await edit({ snapping: false }); await drag(r.x + r.w - 2, r.y + r.h / 2, r.x + r.w - 2 - 100, r.y + r.h / 2); const a = await clip('A'); const b = await clip('B'); assert(Math.abs(a.out - 3 * S) < 0.05 * S, `A.out ${a.out}`); assert(Math.abs(b.start - 3 * S) < 0.05 * S, `B.start ${b.start}`); });
    await scenario('trim without ripple leaves a gap', async () => { await edit({ ripple: false, snapping: false }); const r = await rect('A'); await drag(r.x + r.w - 2, r.y + r.h / 2, r.x + r.w - 2 - 100, r.y + r.h / 2); const b = await clip('B'); assert(b.start === 4 * S, `B.start ${b.start}`); });
    await scenario('trim a start edge moves the source in point', async () => { await edit({ ripple: false, snapping: false }); const r = await rect('B'); await drag(r.x + 2, r.y + r.h / 2, r.x + 2 + 50, r.y + r.h / 2); const b = await clip('B'); assert(Math.abs(b.start - 4.5 * S) < 0.05 * S && Math.abs(b.in - 5.5 * S) < 0.05 * S, `B ${b.start} ${b.in}`); });
    await scenario('blade tool cuts where clicked', async () => { await edit({ tool: 'blade', snapping: false }); await click(await xAt(2 * S), await laneY('camera')); const cam = await clipsOn('camera'); assert(cam.length === 3, `${cam.length} clips`); assert(Math.abs(cam[1].start - 2 * S) < 0.03 * S, `cut at ${cam[1].start}`); });
    await scenario('Cmd+B splits the selected clip at the playhead', async () => { await click(mid(await rect('A')).x, mid(await rect('A')).y); await win.evaluate(() => globalThis.__directorEditCmd.seek(1_000_000)); await key('Meta+b'); const cam = await clipsOn('camera'); assert(cam.length === 3 && cam[1].start === S, `${cam.map((c) => c.start)}`); const v = await clipsOn('voice'); assert(v.length === 2, 'linked voice split too'); });
    await scenario('Cmd+B with nothing selected cuts every lane', async () => { await win.evaluate(() => globalThis.__directorEditCmd.seek(6_000_000)); await key('Meta+b'); const cam = await clipsOn('camera'); const titles = await clipsOn('titles'); assert(cam.length === 3 && titles.length === 2, `${cam.length} ${titles.length}`); });
    await scenario('Delete ripples later clips left', async () => { await click(mid(await rect('A')).x, mid(await rect('A')).y); await key('Delete'); const cam = await clipsOn('camera'); assert(cam.length === 1 && cam[0].id === 'B' && cam[0].start === 0, `${JSON.stringify(cam.map((c) => [c.id, c.start]))}`); assert((await clipsOn('voice')).length === 0, 'linked voice deleted'); });
    await scenario('Shift+Delete removes and leaves a gap', async () => { await click(mid(await rect('A')).x, mid(await rect('A')).y); await key('Shift+Delete'); const b = await clip('B'); assert(b.start === 4 * S, `B ${b.start}`); });
    await scenario('Cmd+Z undoes and Cmd+Shift+Z redoes', async () => { await click(mid(await rect('A')).x, mid(await rect('A')).y); await key('Delete'); await key('Meta+z'); assert(await clip('A'), 'restored'); await key('Meta+Shift+z'); assert(!(await clip('A')), 'deleted again'); });
    await scenario('Cmd+D duplicates after the clip', async () => { await click(mid(await rect('T')).x, mid(await rect('T')).y); await key('Meta+d'); const t = await clipsOn('titles'); assert(t.length === 2 && t[1].start === 7 * S, `${t.map((c) => c.start)}`); });
    await scenario('Q trims the start to the playhead', async () => { await click(mid(await rect('B')).x, mid(await rect('B')).y); await win.evaluate(() => globalThis.__directorEditCmd.seek(5_000_000)); await key('q'); const b = await clip('B'); assert(b.in === 6 * S, `B.in ${b.in}`); });
    await scenario('W trims the end to the playhead', async () => { await click(mid(await rect('A')).x, mid(await rect('A')).y); await win.evaluate(() => globalThis.__directorEditCmd.seek(3_000_000)); await key('w'); const a = await clip('A'); assert(a.out === 3 * S, `A.out ${a.out}`); });
    await scenario('Alt+Right nudges one frame', async () => { await click(mid(await rect('T')).x, mid(await rect('T')).y); await key('Alt+ArrowRight'); const t = await clip('T'); assert(t.start === 5 * S + 33_333, `T.start ${t.start}`); });
    await scenario('marquee selects across lanes', async () => { const x0 = await xAt(3.5 * S); const x1 = await xAt(5.5 * S); const y0 = (await laneY('titles')) - 10; const y1 = (await laneY('camera')) + 10; await drag(x0, y0, x1, y1); const s = (await sel()).sort().join(); assert(s === 'A,B,T', `sel ${s}`); });
    await scenario('dragging on the ruler scrubs the playhead', async () => { const b = await win.evaluate(() => globalThis.__directorTimeline.canvasRect()); await drag(await xAt(1 * S), b.top + 10, await xAt(3 * S), b.top + 10); const t = await win.evaluate(() => globalThis.__directorEditCmd.getEdit().t); assert(Math.abs(t - 3 * S) < 0.05 * S, `t ${t}`); });
    await scenario('slip tool shifts the source range in place', async () => { await edit({ tool: 'slip' }); const r = await rect('B'); await drag(r.x + 100, r.y + r.h / 2, r.x + 50, r.y + r.h / 2); const b = await clip('B'); assert(b.start === 4 * S && Math.abs(b.in - 5.5 * S) < 0.05 * S && b.out - b.in === 4 * S, `B ${b.start} ${b.in} ${b.out}`); });
    await scenario('roll tool moves the edit point between two clips', async () => { await edit({ tool: 'roll' }); const r = await rect('B'); await drag(r.x + 2, r.y + r.h / 2, r.x + 2 + 50, r.y + r.h / 2); const a = await clip('A'); const b = await clip('B'); assert(Math.abs(a.out - 4.5 * S) < 0.05 * S && Math.abs(b.start - 4.5 * S) < 0.05 * S, `A.out ${a.out} B.start ${b.start}`); });
    await scenario('Cmd+A selects every clip', async () => { await click(await xAt(8.6 * S), await laneY('camera')); await key('Meta+a'); assert((await sel()).length === 4, `${(await sel()).length}`); });
    await scenario('I, O and Cmd+Shift+X delete a range on every lane', async () => { await win.evaluate(() => globalThis.__directorEditCmd.seek(1_000_000)); await key('i'); await win.evaluate(() => globalThis.__directorEditCmd.seek(2_000_000)); await key('o'); await key('Meta+Shift+x'); const a = (await clipsOn('camera')); const total = a.reduce((n, c) => n + (c.out - c.in), 0); assert(total === 7 * S, `camera total ${total}`); const v = (await clipsOn('voice')).reduce((n, c) => n + (c.out - c.in), 0); assert(v === 3 * S, `voice total ${v}`); });
    await scenario('a locked lane ignores edits', async () => { await win.evaluate(() => { const d = globalThis.__directorProject().doc; globalThis.__directorProjectApply([{ op: 'updateLane', id: d.lanes.find((l) => l.kind === 'camera').id, patch: { locked: true } }], 'lock'); }); await win.evaluate(() => globalThis.__directorEditCmd.seek(1_000_000)); await key('Meta+b'); assert((await clipsOn('camera')).length === 2, 'camera untouched'); });
    await scenario('dropping library media onto a lane adds a clip there', async () => {
      const x = await xAt(9 * S); const y = await laneY('broll');
      await win.evaluate(({ x, y, id }) => {
        const canvas = document.querySelector('[data-testid="timeline-canvas"]');
        const dt = new DataTransfer(); dt.setData('application/x-director-media', id);
        canvas.dispatchEvent(new DragEvent('dragover', { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true }));
        canvas.dispatchEvent(new DragEvent('drop', { clientX: x, clientY: y, dataTransfer: dt, bubbles: true, cancelable: true }));
      }, { x, y, id: sync });
      await win.waitForTimeout(100);
      const br = await clipsOn('broll'); assert(br.length === 1 && Math.abs(br[0].start - 9 * S) < 0.05 * S, `${JSON.stringify(br.map((c) => c.start))}`);
    });

    const failed = results.filter((r) => !r.ok);
    assert(results.length >= 25, `only ${results.length} scenarios`);
    assert(failed.length === 0, `${failed.length}/${results.length} scenarios failed:\n${failed.map((f) => `${f.name}: ${f.err}`).join('\n')}`);
    return `${results.length} timeline scenarios passed`;
  } finally { await app.close(); }
}
