import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import './contextmenu.css';

/** One row of a context menu. A row with `items` opens a submenu; `separator` draws a line. */
export interface MenuItem {
  id?: string;
  label?: string;
  hint?: string;
  disabled?: boolean;
  separator?: boolean;
  items?: MenuItem[];
  run?: () => void;
}

interface MenuState { open: { x: number; y: number; items: MenuItem[] } | null }
const useMenu = create<MenuState>(() => ({ open: null }));

/** Open a menu at a point (usually the right-click position). Closes on choice, Escape, a click elsewhere or scroll. */
export function openContextMenu(x: number, y: number, items: MenuItem[]): void { useMenu.setState({ open: { x, y, items } }); }
export function closeContextMenu(): void { useMenu.setState({ open: null }); }
(globalThis as Record<string, unknown>).__directorMenu = { items: () => useMenu.getState().open?.items.map((i) => i.label ?? '-') ?? null };

function List({ items, x, y, onClose, depth, label }: { items: MenuItem[]; x: number; y: number; onClose: () => void; depth: number; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [sub, setSub] = useState<{ i: number; x: number; y: number } | null>(null);
  const live = items.map((it, i) => ({ it, i })).filter(({ it }) => !it.separator && !it.disabled);

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)), y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) });
  }, [x, y]);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])')?.focus(); }, []);

  const openSub = (i: number, el: HTMLElement) => { const r = el.getBoundingClientRect(); setSub({ i, x: r.right - 2, y: r.top - 4 }); };
  const choose = (it: MenuItem, el: HTMLElement) => {
    if (it.disabled) return;
    if (it.items) { openSub(items.indexOf(it), el); return; }
    closeContextMenu(); // the whole menu, also when the choice is in a submenu
    it.run?.();
  };
  const onKey = (e: React.KeyboardEvent) => {
    const btns = [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const at = btns.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => btns[(n + btns.length) % btns.length]?.focus();
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(btns.length - 1);
    else if (e.key === 'ArrowRight' && at >= 0) { const it = live[at]?.it; if (it?.items) openSub(items.indexOf(it), btns[at]!); else return; }
    else if (e.key === 'ArrowLeft' && depth > 0) onClose();
    else if (e.key === 'Escape') { if (depth > 0) onClose(); else closeContextMenu(); }
    else if (e.key === 'Tab') closeContextMenu();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={ref} className="ctx-menu" role="menu" aria-label={label} style={{ left: pos.x, top: pos.y }} onKeyDown={onKey} data-testid={depth ? 'context-submenu' : 'context-menu'}>
      {items.map((it, i) => it.separator
        ? <div key={`s${i}`} className="ctx-sep" role="separator" />
        : (
          <button
            key={it.id ?? it.label ?? i}
            type="button"
            role="menuitem"
            className={`ctx-item ${sub?.i === i ? 'open' : ''}`}
            aria-disabled={it.disabled || undefined}
            aria-haspopup={it.items ? 'menu' : undefined}
            aria-expanded={it.items ? sub?.i === i : undefined}
            data-id={it.id}
            tabIndex={-1}
            onMouseEnter={(e) => { if (it.items && !it.disabled) openSub(i, e.currentTarget); else setSub(null); }}
            onClick={(e) => choose(it, e.currentTarget)}
            onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !it.disabled) { e.preventDefault(); e.stopPropagation(); choose(it, e.currentTarget); } }}
          >
            <span className="ctx-label">{it.label}</span>
            {it.hint && <span className="ctx-hint">{it.hint}</span>}
            {it.items && <span className="ctx-arrow" aria-hidden="true">›</span>}
          </button>
        ))}
      {sub && items[sub.i]?.items && (
        <List items={items[sub.i]!.items!} x={sub.x} y={sub.y} depth={depth + 1} label={items[sub.i]!.label}
          onClose={() => { setSub(null); ref.current?.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')[sub.i]?.focus(); }} />
      )}
    </div>
  );
}

/** Mount once near the app root. */
export function ContextMenuHost() {
  const open = useMenu((s) => s.open);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    const away = (e: Event) => { if (!(e.target as HTMLElement)?.closest?.('.ctx-menu')) closeContextMenu(); };
    const blur = () => closeContextMenu();
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('wheel', away, true);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('wheel', away, true);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
      if (back?.isConnected) back.focus();
    };
  }, [open]);
  if (!open) return null;
  return <List items={open.items} x={open.x} y={open.y} depth={0} onClose={closeContextMenu} />;
}
