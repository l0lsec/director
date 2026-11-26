import { useMemo, useState, useEffect } from 'react';
import { timelineWords, rangesForWords, cutOps, DEFAULT_FILLERS } from '@director/analysis';
import { normalizeWord } from '@director/engine';
import { useProject } from '../../project/store';
import { useEdit } from '../store';
import { seek } from '../player';
import { ensureTranscripts } from './transcripts';
import { registerEditPanel } from '../panels';

const FILLERS = new Set(DEFAULT_FILLERS);

export function TranscriptPanel() {
  const doc = useProject((s) => s.doc);
  const t = useEdit((s) => s.t);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');
  const words = useMemo(() => (doc ? timelineWords(doc) : []), [doc]);
  const current = words.findIndex((w) => t >= w.start && t < w.end);

  const del = () => {
    if (!doc || !sel) return;
    const idx = [];
    for (let i = Math.min(sel.a, sel.b); i <= Math.max(sel.a, sel.b); i++) idx.push(i);
    if (useProject.getState().apply(cutOps(doc, rangesForWords(words, idx)), `Delete "${idx.map((i) => words[i]!.text).join(' ').slice(0, 40)}"`)) setSel(null);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!sel || (e.key !== 'Delete' && e.key !== 'Backspace')) return;
      const tgt = e.target as HTMLElement;
      if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') return;
      e.preventDefault(); e.stopImmediatePropagation(); del();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  (globalThis as Record<string, unknown>).__directorTranscript = { words: () => words, select: (a: number, b: number) => setSel({ a, b }), del, ensureTranscripts };

  if (!doc) return null;
  const qn = normalizeWord(q);
  return (
    <div className="transcript" data-testid="transcript-panel">
      <div className="lib-bar">
        <button className="primary" disabled={busy} onClick={() => { setBusy(true); void ensureTranscripts().finally(() => setBusy(false)); }}>{busy ? 'Transcribing' : words.length ? 'Update' : 'Transcribe'}</button>
        <input placeholder="Find in transcript" aria-label="Find in transcript" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {sel && <div className="row" style={{ padding: '0 8px 6px' }}><button className="mini danger" onClick={del}>Delete {Math.abs(sel.b - sel.a) + 1} words</button><button className="mini" onClick={() => setSel(null)}>Clear</button></div>}
      <div className="words scroll">
        {words.length === 0 && <div className="empty">Transcribe to edit by text: select words and press Delete to cut them from every lane.</div>}
        {words.map((w, i) => {
          const inSel = sel && i >= Math.min(sel.a, sel.b) && i <= Math.max(sel.a, sel.b);
          const filler = FILLERS.has(normalizeWord(w.text));
          const hit = qn && normalizeWord(w.text).includes(qn);
          return (
            <span key={`${w.clipId}-${w.srcStart}`} data-word={i}
              className={`word${i === current ? ' now' : ''}${inSel ? ' sel' : ''}${filler ? ' filler' : ''}${hit ? ' hit' : ''}${w.p != null && w.p < 0.5 ? ' unsure' : ''}`}
              onClick={(e) => { if (e.shiftKey && sel) setSel({ a: sel.a, b: i }); else { setSel({ a: i, b: i }); seek(w.start); } }}>
              {w.text}{' '}
            </span>
          );
        })}
      </div>
    </div>
  );
}

registerEditPanel({ id: 'transcript', label: 'Transcript', component: TranscriptPanel, order: 10 });
