import { useState } from 'react';
import { formatDuration } from '@director/engine';
import { useRecord, sendToEditor, rateTake, renameTake, trashTake, type TakeEntry } from '../controller';
import { invoke } from '../../../shell/bridge';

export function TakesPanel() {
  const takes = useRecord((s) => s.takes);
  const [editing, setEditing] = useState<string | null>(null);
  if (!takes.length) return <div className="hint" style={{ padding: 12 }}>No takes yet. Press Record (or R) to make your first one.</div>;
  return (
    <div className="scroll" data-testid="takes-list">
      {takes.map((e: TakeEntry) => (
        <div className="take" key={e.take.id} data-take={e.take.id}>
          {editing === e.take.id ? (
            <input autoFocus defaultValue={e.take.title} aria-label="Take name" onBlur={(ev) => { void renameTake(e, ev.target.value || e.take.title); setEditing(null); }} onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }} />
          ) : (
            <span className="t" title={e.take.title} onDoubleClick={() => setEditing(e.take.id)}>{e.take.title}</span>
          )}
          <span className="stars" aria-label={`Rating ${e.take.rating} of 5`}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button key={n} className={n <= e.take.rating ? 'on' : ''} aria-label={`Rate ${n}`} onClick={() => void rateTake(e, n === e.take.rating ? 0 : n)}>★</button>
            ))}
          </span>
          <span className="meta">
            {formatDuration(e.take.durationUs)} · {new Date(e.take.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            {e.take.markers.filter((m) => m.kind === 'retake').length ? ` · ${e.take.markers.filter((m) => m.kind === 'retake').length} retakes` : ''}
            {e.take.files.screen ? ' · screen' : ''}
          </span>
          <span className="row" style={{ gap: 4 }}>
            <button className="mini primary" data-testid="send-to-editor" onClick={() => void sendToEditor(e)}>Send to editor</button>
            <button className="mini" title="Show in Finder" onClick={() => void invoke('shell:reveal', { path: `${e.dir}/take.json` })}>Show</button>
            <button className="mini" title="Move to Trash (recoverable)" onClick={() => void trashTake(e)}>Trash</button>
          </span>
        </div>
      ))}
    </div>
  );
}
