import { useShell } from './store';

export function Toasts() {
  const toasts = useShell((s) => s.toasts);
  const dismiss = useShell((s) => s.dismiss);
  if (!toasts.length) return null;
  return (
    <div style={{ position: 'fixed', right: 16, bottom: 16, display: 'grid', gap: 8, zIndex: 60 }} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="toast" style={{ position: 'static', borderColor: t.tone === 'error' ? 'var(--danger)' : t.tone === 'ok' ? 'var(--ok)' : 'var(--line)' }} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
