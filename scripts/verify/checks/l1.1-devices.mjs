import { launchApp, assert } from '../lib.mjs';

// The app's device list must cover every camera and mic the native helper reports, and expose formats.
export default async function () {
  const app = await launchApp();
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('[data-testid="tab-record"]');
    const r = await win.evaluate(async () => {
      const native = await window.director.invoke('native:devices', {});
      const list = await navigator.mediaDevices.enumerateDevices();
      return { native, chromium: list.map((d) => ({ kind: d.kind, label: d.label, id: d.deviceId })) };
    });
    assert(r.native.ok, 'native devices answered');
    const nat = r.native.value;
    const cams = nat.filter((d) => d.kind === 'video');
    const mics = nat.filter((d) => d.kind === 'audio');
    const cvideo = r.chromium.filter((d) => d.kind === 'videoinput');
    const caudio = r.chromium.filter((d) => d.kind === 'audioinput');
    assert(cvideo.length >= cams.length, `Chromium sees ${cvideo.length} cameras, native ${cams.length}`);
    assert(caudio.filter((d) => d.id !== 'default' && d.id !== 'communications').length >= mics.length, `Chromium sees fewer mics than native`);
    const labelled = cvideo.every((d) => d.label);
    if (labelled) for (const c of cams) assert(cvideo.some((d) => d.label.includes(c.name) || c.name.includes(d.label)), `camera ${c.name} missing from app list`);
    for (const c of cams) assert(c.formats.length > 0 && c.formats.every((f) => f.width > 0 && f.maxFps > 0), `formats for ${c.name}`);
    return `${cams.length} cameras and ${mics.length} mics from native; app lists ${cvideo.length} cameras, ${caudio.length} audio inputs; labels ${labelled ? 'matched by name' : 'hidden until camera permission (matched by count)'}`;
  } finally { await app.close(); }
}
