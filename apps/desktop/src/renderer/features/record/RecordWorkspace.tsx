import { useEffect, useRef } from 'react';
import { formatDuration } from '@director/engine';
import './record.css';
import { useShell } from '../../shell/store';
import {
  useRecord, initRecord, startPreview, ensurePreview, stopPreview, setScript, setOption, updatePrompter, openPrompter, closePrompter,
  startRecording, stopRecording, togglePlay, estimate, handleKey, refreshDevices,
} from './controller';
import { TakesPanel } from './takes/TakesPanel';

export default function RecordWorkspace() {
  const s = useRecord();
  const video = useRef<HTMLVideoElement>(null);

  const onboarding = useShell((x) => x.onboarding);
  useEffect(() => {
    // Behind first-run onboarding the camera stays off until the person chooses to record.
    if (onboarding !== false) return;
    void initRecord().then(() => ensurePreview());
    return () => stopPreview();
  }, [onboarding]);
  useEffect(() => { if (video.current) video.current.srcObject = s.stream; }, [s.stream]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
      if ([' ', 'ArrowUp', 'ArrowDown', 'r', 'R', 'm', 'M', 'g', 'G', 'b', 'B', 'Escape'].includes(e.key)) { e.preventDefault(); handleKey(e.key); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const recording = s.phase === 'recording';
  const curLine = s.script.words[Math.min(Math.floor(s.cursor), s.script.wordCount - 1)]?.line ?? 0;

  return (
    <div className="rec" data-testid="record-workspace">
      <aside className="side">
        <section className="panel section" style={{ flex: 1, minHeight: 0 }}>
          <h3>Script</h3>
          <textarea className="script" aria-label="Script" data-testid="script-input" value={s.scriptText} onChange={(e) => setScript(e.target.value)} disabled={recording}
            placeholder="Write or paste your script. Cues in brackets are not read aloud: [HOOK] [ZOOM] [PAUSE] [B-ROLL: what to show] [CTA]" />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="hint">{s.script.wordCount} words · about {estimate()} at {s.wpm} WPM</span>
          </div>
          <div className="line-preview" aria-live="polite">
            {s.script.lines.filter((l) => l.wordCount).slice(Math.max(0, curLine - 1), curLine + 2).map((l) => (
              <div key={l.index} className={l.index === curLine ? 'cur' : ''}>{l.text}</div>
            ))}
          </div>
        </section>
        <section className="panel section">
          <h3>Prompter</h3>
          <div className="seg" role="group" aria-label="Scrolling">
            {(['follow', 'wpm', 'manual'] as const).map((m) => (
              <button key={m} aria-pressed={s.mode === m} onClick={() => setOption('mode', m)}>{m === 'follow' ? 'Follow voice' : m === 'wpm' ? 'Fixed speed' : 'Manual'}</button>
            ))}
          </div>
          <div className="grid2">
            <label htmlFor="wpm">Speed (WPM)</label>
            <input id="wpm" type="number" min={60} max={320} step={5} value={s.wpm} onChange={(e) => setOption('wpm', Number(e.target.value))} />
            <label htmlFor="psize">Text size</label>
            <input id="psize" type="range" min={20} max={120} value={s.prompter.fontSize} onChange={(e) => updatePrompter({ fontSize: Number(e.target.value) })} />
            <label htmlFor="pwidth">Text width</label>
            <input id="pwidth" type="range" min={40} max={100} value={s.prompter.widthPct} onChange={(e) => updatePrompter({ widthPct: Number(e.target.value) })} />
            <label htmlFor="pline">Reading line</label>
            <input id="pline" type="range" min={5} max={70} value={Math.round(s.prompter.readingLine * 100)} onChange={(e) => updatePrompter({ readingLine: Number(e.target.value) / 100 })} />
            <label htmlFor="popac">Background</label>
            <input id="popac" type="range" min={0} max={100} value={Math.round(s.prompter.opacity * 100)} onChange={(e) => updatePrompter({ opacity: Number(e.target.value) / 100 })} />
            <label htmlFor="pwin">Window</label>
            <select id="pwin" value={s.windowMode} onChange={(e) => { setOption('windowMode', e.target.value as never); if (s.prompterOpen) void openPrompter(e.target.value as never); }}>
              <option value="overlay">Under the camera</option>
              <option value="display">Second display</option>
              <option value="glass">Beam-splitter glass (mirrored)</option>
            </select>
          </div>
          <label className="row"><input type="checkbox" checked={s.prompter.mirror} onChange={(e) => updatePrompter({ mirror: e.target.checked })} /> Mirror text</label>
          <div className="row">
            <button data-testid="prompter-toggle" className={s.prompterOpen ? '' : 'primary'} onClick={() => void (s.prompterOpen ? closePrompter() : openPrompter())}>{s.prompterOpen ? 'Close prompter' : 'Open prompter'}</button>
            <button onClick={() => void togglePlay()} disabled={recording}>{s.playing ? 'Pause' : 'Rehearse'}</button>
          </div>
        </section>
      </aside>

      <section className="stage">
        <div className="preview panel">
          {s.stream ? <video ref={video} autoPlay muted playsInline data-testid="camera-preview" /> : <div className="empty">{s.error ?? 'Starting camera'}</div>}
          <div className="overlay">
            {s.overlays.safe && <div className="safe916" />}
            {s.overlays.thirds && <div className="thirds" />}
            {s.overlays.eyeline && <div className="eyeline" />}
          </div>
          {s.countdown != null && <div className="count" data-testid="countdown">{s.countdown}</div>}
        </div>
        {s.error && <div className="error" role="alert">{s.error} <button className="mini" onClick={() => void refreshDevices().then(startPreview)}>Try again</button></div>}
        <div className="panel recbar">
          <button
            className={`recbtn ${recording ? 'on' : ''}`}
            data-testid="record-button"
            aria-label={recording ? 'Stop recording' : 'REC: start recording'}
            disabled={s.phase === 'stopping' || s.phase === 'countdown'}
            onClick={() => void (recording ? stopRecording() : startRecording())}
          >{recording ? '' : 'REC'}</button>
          <div className="col" style={{ gap: 4 }}>
            <span className="timer" data-testid="rec-timer">{recording ? formatDuration(s.elapsedUs) : s.phase === 'countdown' ? 'Get ready' : 'Ready'}</span>
            <div className="meter" role="meter" aria-label="Microphone level" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(Math.sqrt(s.level) * 140))}><i style={{ width: `${Math.min(100, Math.round(Math.sqrt(s.level) * 140))}%` }} /></div>
          </div>
          <span className="hint" style={{ marginLeft: 'auto' }}>
            <kbd>Space</kbd> pause · <kbd>R</kbd> retake line · <kbd>M</kbd> marker · <kbd>G</kbd>/<kbd>B</kbd> good/bad · <kbd>Esc</kbd> stop
          </span>
        </div>
      </section>

      <aside className="side">
        <section className="panel section">
          <h3>Camera and mic</h3>
          <select aria-label="Camera" value={s.cameraId} onChange={(e) => setOption('cameraId', e.target.value)}>
            {s.cameras.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <div className="grid2">
            <select aria-label="Resolution" value={s.resolution} onChange={(e) => setOption('resolution', e.target.value as never)}>
              <option value="720p">720p</option><option value="1080p">1080p</option><option value="4k">4K</option><option value="vertical">1080x1920 vertical</option>
            </select>
            <select aria-label="Frame rate" value={s.fps} onChange={(e) => setOption('fps', Number(e.target.value))}>
              <option value={24}>24 fps</option><option value={30}>30 fps</option><option value={60}>60 fps</option>
            </select>
          </div>
          <select aria-label="Microphone" value={s.micId} onChange={(e) => setOption('micId', e.target.value)}>
            {s.mics.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <div className="grid2">
            <label htmlFor="aoff" title="If your voice lands late on video, raise this. Measure once with a hand clap.">Audio sync (ms)</label>
            <input id="aoff" type="number" min={-500} max={500} step={5} value={s.audioOffsetMs} onChange={(e) => setOption('audioOffsetMs', Number(e.target.value))} />
          </div>
          <label className="row"><input type="checkbox" checked={s.screenOn} onChange={(e) => setOption('screenOn', e.target.checked)} /> Also record the screen</label>
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            <label className="row"><input type="checkbox" checked={s.overlays.safe} onChange={(e) => setOption('overlays', { ...s.overlays, safe: e.target.checked })} /> 9:16</label>
            <label className="row"><input type="checkbox" checked={s.overlays.thirds} onChange={(e) => setOption('overlays', { ...s.overlays, thirds: e.target.checked })} /> Thirds</label>
            <label className="row"><input type="checkbox" checked={s.overlays.eyeline} onChange={(e) => setOption('overlays', { ...s.overlays, eyeline: e.target.checked })} /> Eye line</label>
          </div>
        </section>
        <section className="panel" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="panel-title">Takes</div>
          <TakesPanel />
        </section>
      </aside>
    </div>
  );
}
