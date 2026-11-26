import { useEffect, useMemo, useRef, useState } from 'react';
import { listCommands, runCommand, type Command } from './registry';

/** Cmd+K command palette. Every registered command is reachable here. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); setQuery(''); setIndex(0); }
      else if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const results: Command[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = listCommands().filter((c) => c.enabled?.() ?? true);
    if (!q) return all.slice(0, 50);
    return all
      .map((c) => ({ c, score: score(`${c.group} ${c.title} ${c.keywords ?? ''}`.toLowerCase(), q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map((x) => x.c);
  }, [query, open]);

  if (!open) return null;
  const choose = (c: Command | undefined) => { if (!c) return; setOpen(false); void runCommand(c.id); };
  return (
    <div className="modal-backdrop" onMouseDown={() => setOpen(false)}>
      <div className="modal" style={{ width: 620, padding: 0 }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          ref={input}
          data-testid="palette-input"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-autocomplete="list"
          aria-activedescendant={results[index] ? `cmd-${results[index]!.id}` : undefined}
          placeholder="Type a command"
          value={query}
          style={{ width: '100%', border: 'none', borderBottom: '1px solid var(--line)', borderRadius: 0, padding: 14, fontSize: 15 }}
          onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
            if (e.key === 'Enter') { e.preventDefault(); choose(results[index]); }
          }}
        />
        <div className="scroll" style={{ maxHeight: 420 }} role="listbox" id="palette-list" aria-label="Commands" tabIndex={-1}>
          {results.map((c, i) => (
            <div
              key={c.id}
              id={`cmd-${c.id}`}
              role="option"
              aria-selected={i === index}
              data-command={c.id}
              onMouseEnter={() => setIndex(i)}
              onClick={() => choose(c)}
              style={{ display: 'flex', gap: 10, padding: '8px 14px', background: i === index ? 'var(--bg-3)' : 'transparent', cursor: 'pointer' }}
            >
              <span style={{ color: 'var(--text-faint)', width: 70 }}>{c.group}</span>
              <span style={{ flex: 1 }}>{c.title}<span style={{ color: 'var(--text-faint)', marginLeft: 8 }}>{c.description}</span></span>
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </div>
          ))}
          {results.length === 0 && <div className="empty" style={{ height: 80 }}>No matching command</div>}
        </div>
      </div>
    </div>
  );
}

function score(hay: string, q: string): number {
  if (hay.includes(q)) return 100 - hay.indexOf(q);
  let i = 0;
  for (const ch of hay) if (ch === q[i]) i++;
  return i === q.length ? 10 : 0;
}
