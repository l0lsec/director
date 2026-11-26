import { useEffect, useState } from 'react';
import './onboarding.css';
import { invoke } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { setScript, setOption, ensurePreview, startRecording, useRecord } from '../record/controller';

type Kind = 'camera' | 'microphone' | 'screen';
type State = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
type Step = 'welcome' | 'permissions' | 'script';
type Goal = 'record' | 'edit' | 'swipe';

const SAMPLE = `[HOOK] Here is one thing I wish I knew sooner.
Most videos lose people in the first two seconds.
[ZOOM] So say the payoff first, then explain it.
[PAUSE]
[CTA] Follow for more.`;

const LABEL: Record<Kind, string> = { camera: 'Camera', microphone: 'Microphone', screen: 'Screen recording' };
const WHY: Record<Kind, string> = {
  camera: 'To record you while you read the prompter.',
  microphone: 'To record your voice and let the prompter follow it.',
  screen: 'Optional: only for recording your screen. macOS asks the first time you use it.',
};

const live = (s: MediaStream | null) => !!s && s.getVideoTracks().some((t) => t.readyState === 'live');
function waitForStream(ms: number): Promise<MediaStream | null> {
  return new Promise((resolve) => {
    const now = useRecord.getState().stream;
    if (live(now)) { resolve(now); return; }
    const timer = setTimeout(() => { unsub(); resolve(null); }, ms);
    const unsub = useRecord.subscribe((s) => { if (live(s.stream)) { clearTimeout(timer); unsub(); resolve(s.stream); } });
  });
}

async function finish(goal: Goal): Promise<void> {
  await invoke('settings:set', { key: 'onboarding.done', value: true });
  useShell.getState().setWorkspace(goal);
}

function PermissionRow({ kind, state, onChange }: { kind: Kind; state: State; onChange: () => void }) {
  const ask = async () => { await invoke('app:requestPermission', { kind }); onChange(); };
  return (
    <div className="ob-perm" data-perm={kind} data-state={state}>
      <div className="col" style={{ gap: 2 }}>
        <strong>{LABEL[kind]}</strong>
        <span className="hint">{WHY[kind]}</span>
        {(state === 'denied' || state === 'restricted') && (
          <span className="hint">{state === 'restricted' ? 'Blocked by a profile on this Mac.' : 'Turned off for Director.'} Open System Settings, switch Director on under Privacy &amp; Security, {LABEL[kind]}, then check again.</span>
        )}
      </div>
      {state === 'granted' ? <span className="chip ok" aria-label={`${LABEL[kind]} allowed`}>Allowed</span>
        : state === 'denied' || state === 'restricted' ? <button onClick={() => void invoke('app:openPrivacySettings', { kind })} data-testid={`open-settings-${kind}`}>Open System Settings</button>
        : kind === 'screen' ? <span className="chip">Asked when needed</span>
        : <button className="primary" onClick={() => void ask()} data-testid={`allow-${kind}`}>Allow</button>}
    </div>
  );
}

export function Onboarding() {
  const [show, setShow] = useState(false);
  const [step, setStep] = useState<Step>('welcome');
  const [perms, setPerms] = useState<Record<Kind, State> | null>(null);
  const [text, setText] = useState(SAMPLE);
  const [wpm, setWpm] = useState(150);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void invoke('app:onboarding', {}).then((r) => { setShow(r.show); useShell.setState({ onboarding: r.show }); }); }, []);
  useEffect(() => { if (!show) useShell.setState({ onboarding: false }); }, [show]);
  const refresh = () => invoke('app:permissions', {}).then((p) => { setPerms(p); return p; });
  if (!show) return null;
  const ready = perms?.camera === 'granted' && perms?.microphone === 'granted';
  const pick = async (goal: Goal) => {
    if (goal !== 'record') { await finish(goal); setShow(false); return; }
    const p = await refresh();
    setStep(p.camera === 'granted' && p.microphone === 'granted' ? 'script' : 'permissions');
  };
  const record = async () => {
    setBusy(true);
    try {
      setScript(text);
      setOption('wpm', wpm);
      await finish('record');
      setShow(false);
      // Record may have opened its camera behind this dialog, possibly before access was granted.
      // Start it only if it is not running or starting, then begin once a live track is there.
      await ensurePreview();
      const stream = await waitForStream(15_000);
      if (stream) await startRecording();
      else useShell.getState().toast('The camera did not start. Check camera and microphone access, then press Record.', 'error');
    } finally { setBusy(false); }
  };
  const steps: Step[] = perms && ready && step === 'script' ? ['welcome', 'script'] : ['welcome', 'permissions', 'script'];
  return (
    <div className="modal-backdrop ob" data-testid="onboarding" data-step={step}>
      <div className="modal col ob-card" role="dialog" aria-label="Get started" aria-modal="true">
        <ol className="ob-steps" aria-label="Steps">{steps.map((s, i) => <li key={s} aria-current={s === step ? 'step' : undefined}>{i + 1}</li>)}</ol>
        {step === 'welcome' && (
          <>
            <h2>Welcome to Director</h2>
            <p className="hint">Write, record with a teleprompter, cut and caption short videos. Everything runs on your Mac; nothing to subscribe to.</p>
            <div className="ob-choices">
              <button className="ob-choice primary" onClick={() => void pick('record')} data-testid="ob-record"><strong>Record with the teleprompter</strong><span>Read a script while the prompter follows your voice.</span></button>
              <button className="ob-choice" onClick={() => void pick('edit')} data-testid="ob-edit"><strong>Edit a video I have</strong><span>Import footage, cut by transcript, add captions.</span></button>
              <button className="ob-choice" onClick={() => void pick('swipe')} data-testid="ob-swipe"><strong>Study a reel that worked</strong><span>Save references, see their pacing and structure.</span></button>
            </div>
          </>
        )}
        {step === 'permissions' && perms && (
          <>
            <h2>Camera and microphone</h2>
            <p className="hint">Director records to files on this Mac. macOS asks you once.</p>
            {(['camera', 'microphone', 'screen'] as Kind[]).map((k) => <PermissionRow key={k} kind={k} state={perms[k]} onChange={() => void refresh()} />)}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button onClick={() => void refresh()} data-testid="ob-recheck">Check again</button>
              <div className="row">
                {!ready && <button onClick={() => setStep('script')} data-testid="ob-skip-perms">Continue anyway</button>}
                <button className="primary" disabled={!ready} onClick={() => setStep('script')} data-testid="ob-continue">Continue</button>
              </div>
            </div>
          </>
        )}
        {step === 'script' && (
          <>
            <h2>Your first script</h2>
            <p className="hint">Edit this or paste your own. Cues in [BRACKETS] are not read aloud.</p>
            <textarea rows={7} value={text} onChange={(e) => setText(e.target.value)} aria-label="First script" data-testid="ob-script" />
            <label className="row">Speaking rate
              <select value={wpm} onChange={(e) => setWpm(Number(e.target.value))} aria-label="Speaking rate">
                <option value={120}>Relaxed (120 wpm)</option><option value={150}>Natural (150 wpm)</option><option value={180}>Fast (180 wpm)</option>
              </select>
            </label>
            {!ready && perms && <p className="hint">Camera or microphone is off, so recording may not start. You can fix it later in System Settings.</p>}
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <button onClick={() => void finish('record').then(() => setShow(false))}>Not now</button>
              <button className="primary" onClick={() => void record()} disabled={busy || !text.trim()} data-testid="ob-start">Start recording</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
