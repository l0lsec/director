import { useEffect, useRef } from 'react';
import { formatTimecode, timelineDuration, CANVAS_PRESETS } from '@director/engine';
import { useProject } from '../../project/store';
import { useEdit, setEdit } from '../store';
import { attachPlayer, seek, togglePlay, getPlayer } from '../player';

const SAFE: Record<string, { top: number; bottom: number; right: number; left: number }> = {
  reels: { top: 0.12, bottom: 0.2, right: 0.15, left: 0.04 },
  tiktok: { top: 0.1, bottom: 0.22, right: 0.16, left: 0.04 },
  shorts: { top: 0.1, bottom: 0.18, right: 0.14, left: 0.04 },
};

export function Preview() {
  const doc = useProject((s) => s.doc);
  const { t, playing, previewScale } = useEdit();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (canvas.current) attachPlayer(canvas.current); }, [!!doc]);
  useEffect(() => { const p = getPlayer(); if (p) { p.scale = previewScale; void p.seek(useEdit.getState().t); } }, [previewScale]);
  if (!doc) return <div className="preview-wrap"><div className="empty">No project</div></div>;
  const dur = timelineDuration(doc);
  const aspect = doc.canvas.width / doc.canvas.height;
  const safe = doc.settings.safeZone !== 'none' && doc.canvas.height > doc.canvas.width ? SAFE[doc.settings.safeZone] : null;
  const setCanvas = (preset: string) => { const p = CANVAS_PRESETS[preset]; if (p) useProject.getState().apply([{ op: 'setCanvas', patch: p }], 'Canvas size'); };
  return (
    <div className="preview-wrap" data-testid="preview">
      <div className="preview-stage">
        <div className="preview-frame" style={{ aspectRatio: `${aspect}` }}>
          <canvas ref={canvas} data-testid="preview-canvas" />
          {safe && <div className="safe-zone" style={{ top: `${safe.top * 100}%`, bottom: `${safe.bottom * 100}%`, left: `${safe.left * 100}%`, right: `${safe.right * 100}%` }} title="Platform safe zone: keep text inside" />}
        </div>
      </div>
      <div className="transport">
        <button aria-label={playing ? 'Pause' : 'Play'} data-testid="play" onClick={togglePlay} className="primary">{playing ? 'Pause' : 'Play'}</button>
        <span className="tc">{formatTimecode(t, doc.canvas.fps)} / {formatTimecode(dur, doc.canvas.fps)}</span>
        <input aria-label="Playhead" type="range" min={0} max={Math.max(1, dur)} value={Math.min(t, dur)} onChange={(e) => seek(Number(e.target.value))} style={{ flex: 1 }} />
        <select aria-label="Canvas" value={Object.entries(CANVAS_PRESETS).find(([, v]) => v.width === doc.canvas.width && v.height === doc.canvas.height)?.[0] ?? ''} onChange={(e) => setCanvas(e.target.value)}>
          <option value="vertical-1080">9:16</option><option value="landscape-1080">16:9</option><option value="square-1080">1:1</option><option value="portrait-4x5">4:5</option><option value="landscape-4k">16:9 4K</option>
          {!Object.values(CANVAS_PRESETS).some((v) => v.width === doc.canvas.width && v.height === doc.canvas.height) && <option value="">{doc.canvas.width}x{doc.canvas.height}</option>}
        </select>
        <select aria-label="Safe zone" value={doc.settings.safeZone} onChange={(e) => useProject.getState().apply([{ op: 'setMeta', patch: { settings: { ...doc.settings, safeZone: e.target.value as 'none' } } }], 'Safe zone')}>
          <option value="none">No guides</option><option value="reels">Reels guides</option><option value="tiktok">TikTok guides</option><option value="shorts">Shorts guides</option>
        </select>
        <select aria-label="Preview quality" value={previewScale} onChange={(e) => setEdit({ previewScale: Number(e.target.value) })}>
          <option value={0.25}>Quarter</option><option value={0.5}>Half</option><option value={1}>Full</option>
        </select>
      </div>
    </div>
  );
}
