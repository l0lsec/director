export interface PrompterSettings {
  fontSize: number;
  lineHeight: number;
  widthPct: number;
  mirror: boolean;
  color: string;
  dimColor: string;
  highlight: string;
  background: string;
  opacity: number;
  readingLine: number; // 0..1 from the top
  showCues: boolean;
  uppercase: boolean;
}

export const DEFAULT_PROMPTER: PrompterSettings = {
  fontSize: 44, lineHeight: 1.3, widthPct: 92, mirror: false, color: '#ffffff', dimColor: 'rgba(255,255,255,0.35)',
  highlight: '#f5b83d', background: '#000000', opacity: 0.82, readingLine: 0.22, showCues: true, uppercase: false,
};

export interface PrompterLine { text: string; firstWord: number; wordCount: number; cues: Array<{ kind: string; label: string; wordIndex: number }> }

export interface PrompterState {
  lines: PrompterLine[];
  words: string[];
  cursor: number;
  settings: PrompterSettings;
  mode: 'follow' | 'wpm' | 'manual';
  playing: boolean;
  recording: boolean;
  countdown: number | null;
  elapsed: string;
  windowMode: 'overlay' | 'display' | 'glass';
}
