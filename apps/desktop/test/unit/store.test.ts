import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectBundle, openProjectBundle, ProjectSession } from '../../src/main/store/projectStore';
import { newProject } from '@director/engine';

const root = join(__dirname, '../../../..');

describe('project store', () => {
  it('journals, snapshots and reopens identically', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dstore-')), 'a.director');
    createProjectBundle(dir, newProject({ name: 'a', id: 'proj_a' }));
    const s = new ProjectSession(dir, openProjectBundle(dir), 60_000);
    s.journal([{ op: 'setMeta', patch: { name: 'renamed' } }]);
    s.journal([{ op: 'addMarker', marker: { id: 'm1', t: 5, kind: 'note', label: 'x' } }]);
    expect(() => s.journal([{ op: 'removeClip', id: 'missing' }])).toThrow();
    const before = s.doc;
    s.close();
    const again = openProjectBundle(dir);
    expect(again.doc.name).toBe('renamed');
    expect(again.doc.markers).toEqual(before.markers);
    expect(again.seq).toBe(2);
  });

  it('ignores a torn final journal line', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dstore-')), 'b.director');
    createProjectBundle(dir, newProject({ name: 'b', id: 'proj_b' }));
    appendFileSync(join(dir, 'journal.jsonl'), JSON.stringify({ seq: 1, ops: [{ op: 'setMeta', patch: { name: 'one' } }] }) + '\n{"seq":2,"ops":[{"op":"setM');
    const r = openProjectBundle(dir);
    expect(r.doc.name).toBe('one');
    expect(r.droppedLines).toBe(1);
  });

  it('SIGKILL mid-edit loses at most the last 2 seconds of ops', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'dcrash-')), 'c.director');
    const child = spawn(process.execPath, ['--no-warnings', '--import', join(root, 'scripts/verify/ts-register.mjs'), join(__dirname, '../child/journal-writer.ts'), dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    const acks: Array<{ seq: number; at: number }> = [];
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.setEncoding('utf8');
    let buf = '';
    child.stdout.on('data', (d: string) => {
      buf += d;
      const lines = buf.split('\n'); buf = lines.pop()!;
      for (const l of lines) { const m = /^ack (\d+) (\d+)/.exec(l); if (m) acks.push({ seq: Number(m[1]), at: Number(m[2]) }); }
    });
    await new Promise((r) => setTimeout(r, 3000));
    const killedAt = Date.now();
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    expect(err).toBe('');
    expect(acks.length).toBeGreaterThan(50);
    const r = openProjectBundle(dir);
    const recoveredMax = r.doc.markers.length;
    // Every op acknowledged more than 2 s before the kill must be present.
    const mustHave = acks.filter((a) => a.at <= killedAt - 2000).reduce((m, a) => Math.max(m, a.seq), 0);
    expect(recoveredMax).toBeGreaterThanOrEqual(mustHave);
    // In practice fsync per transaction means nothing acknowledged is lost at all.
    const lastAck = acks[acks.length - 1]!.seq;
    expect(recoveredMax).toBeGreaterThanOrEqual(lastAck);
    expect(r.seq).toBe(recoveredMax);
  });
});
