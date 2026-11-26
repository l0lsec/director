import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke, onEvent } from '../../../shell/bridge';
import { DEFAULT_PROMPTER, type PrompterState } from './types';
import './prompter.css';

const EMPTY: PrompterState = { lines: [], words: [], cursor: 0, settings: DEFAULT_PROMPTER, mode: 'follow', playing: false, recording: false, countdown: null, elapsed: '0:00.0', windowMode: 'overlay' };

/** The prompter window: big, readable text that scrolls so the current line sits on the reading line. */
export function PrompterApp() {
  const [st, setSt] = useState<PrompterState>(EMPTY);
  const box = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const off = onEvent('prompter:state', (s) => setSt(s as PrompterState));
    void invoke('prompter:command', { command: 'ready' });
    const onKey = (e: KeyboardEvent) => {
      if ([' ', 'ArrowUp', 'ArrowDown', 'r', 'R', 'm', 'M', 'g', 'G', 'b', 'B', 'Escape'].includes(e.key)) {
        e.preventDefault();
        void invoke('prompter:command', { command: `key:${e.key}` });
      }
    };
    const onWheel = (e: WheelEvent) => { void invoke('prompter:command', { command: 'nudge', value: Math.sign(e.deltaY) * 2 }); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => { off(); window.removeEventListener('keydown', onKey); window.removeEventListener('wheel', onWheel); };
  }, []);

  const cursor = st.cursor;
  const curIdx = Math.min(Math.floor(cursor), Math.max(0, st.words.length - 1));
  const curLine = st.lines.find((l) => l.wordCount > 0 && curIdx >= l.firstWord && curIdx < l.firstWord + l.wordCount) ?? st.lines.find((l) => l.wordCount > 0);
  const lineIndex = curLine ? st.lines.indexOf(curLine) : 0;

  useLayoutEffect(() => {
    const el = lineRefs.current.get(lineIndex);
    const h = box.current?.clientHeight ?? 0;
    if (!el) return;
    // Within a line, glide in proportion to progress through it.
    const frac = curLine && curLine.wordCount ? Math.min(1, Math.max(0, (cursor - curLine.firstWord) / curLine.wordCount)) : 0;
    setOffset(el.offsetTop + frac * Math.max(0, el.offsetHeight - st.settings.fontSize * st.settings.lineHeight) - h * st.settings.readingLine);
  }, [lineIndex, cursor, st.settings, st.lines]);

  const s = st.settings;
  const mirror = s.mirror || st.windowMode === 'glass';
  return (
    <div className="prompter" style={{ background: `color-mix(in srgb, ${s.background} ${Math.round(s.opacity * 100)}%, transparent)` }} data-testid="prompter">
      <div className="drag" title="Drag to move" />
      <div className="viewport" ref={box} style={{ transform: mirror ? 'scaleX(-1)' : undefined }}>
        <div className="reading" style={{ top: `${s.readingLine * 100}%`, height: s.fontSize * s.lineHeight }} />
        <div className="text" style={{ width: `${s.widthPct}%`, fontSize: s.fontSize, lineHeight: s.lineHeight, transform: `translateY(${-offset}px)`, textTransform: s.uppercase ? 'uppercase' : undefined }}>
          {st.lines.map((l, li) => (
            <div key={li} className="pline" ref={(el) => { if (el) lineRefs.current.set(li, el); else lineRefs.current.delete(li); }}>
              {s.showCues && l.cues.map((c, ci) => <span key={`c${ci}`} className={`cue cue-${c.kind}`}>{c.label.toUpperCase()}</span>)}
              {Array.from({ length: l.wordCount }, (_, k) => {
                const i = l.firstWord + k;
                const cls = i < Math.floor(cursor) ? 'w read' : i === Math.floor(cursor) ? 'w now' : 'w';
                return <span key={i} className={cls} style={{ color: i < Math.floor(cursor) ? s.dimColor : i === Math.floor(cursor) ? s.highlight : s.color }}>{st.words[i]} </span>;
              })}
            </div>
          ))}
          {st.lines.length === 0 && <div className="pline" style={{ color: s.dimColor }}>Write a script in the Record tab.</div>}
        </div>
      </div>
      <div className="status">
        {st.recording && <span className="dot" />}
        <span>{st.recording ? st.elapsed : st.playing ? 'Rehearsing' : 'Paused'}</span>
        <span className="mode">{st.mode === 'follow' ? 'Follow voice' : st.mode === 'wpm' ? 'Fixed speed' : 'Manual'}</span>
      </div>
      {st.countdown != null && <div className="pcount">{st.countdown}</div>}
    </div>
  );
}
