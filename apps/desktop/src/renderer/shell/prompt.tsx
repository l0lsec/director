import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

interface Ask { title: string; label?: string; placeholder?: string; initial?: string; confirm?: string; resolve: (v: string | null) => void }
const usePrompt = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** A small in-app text prompt (Electron has no window.prompt). Resolves null on cancel. */
export function ask(opts: Omit<Ask, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    usePrompt.getState().ask?.resolve(null);
    usePrompt.setState({ ask: { ...opts, resolve } });
  });
}

export function PromptHost() {
  const a = usePrompt((s) => s.ask);
  const [v, setV] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { setV(a?.initial ?? ''); if (a) setTimeout(() => ref.current?.focus(), 0); }, [a]);
  if (!a) return null;
  const done = (val: string | null) => { usePrompt.setState({ ask: null }); a.resolve(val); };
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && done(null)}>
      <form className="modal col" role="dialog" aria-label={a.title} data-testid="prompt" onSubmit={(e) => { e.preventDefault(); done(v.trim() ? v : null); }} onKeyDown={(e) => e.key === 'Escape' && done(null)}>
        <strong>{a.title}</strong>
        {a.label && <label htmlFor="ask-input">{a.label}</label>}
        <input id="ask-input" ref={ref} value={v} placeholder={a.placeholder} onChange={(e) => setV(e.target.value)} aria-label={a.label ?? a.title} />
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" onClick={() => done(null)}>Cancel</button>
          <button type="submit" className="primary" disabled={!v.trim()}>{a.confirm ?? 'OK'}</button>
        </div>
      </form>
    </div>
  );
}
