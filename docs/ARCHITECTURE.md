# Architecture

How Director is put together, and the rules the code keeps to. The [README](../README.md) has the code layout table and how to build.

## Principles

Every screen is checked against these:

1. **One obvious next step.** Each workspace has one primary button (Record, Make Reel, Export). Secondary tools live in the inspector or the command palette.
2. **Familiar where it counts.** Media on the left, preview in the centre, inspector on the right, timeline at the bottom, as in most editors.
3. **Never lose work.** Autosave on every change, crash recovery, unlimited undo, non-destructive edits, deletes go to Trash.
4. **Fast feels good.** Scrubbing responds quickly, playback does not stutter (proxies are automatic), and exporting a 60 s reel takes well under a minute.
5. **AI proposes, you decide.** Every automated edit (AutoCut, Make Reel, the Director pass, an assistant over MCP) arrives as one undoable change. Nothing is applied silently.
6. **Local first, private by default.** Transcription, cutting, captions, background removal and reframing run on the Mac. Only text is ever sent to Claude, and only when you ask for a Claude feature.
7. **Keyboard first, mouse friendly.** Every command is in the command palette (Cmd+K) and most have a shortcut; drag and drop works everywhere.
8. **Short-form native, long-form ready.** 9:16 is the default canvas, platform safe zones are one toggle away, and captions are a lane of their own.
9. **Readable at a glance.** A dark theme tuned for video work, large hit targets, plain-language labels ("Remove pauses" rather than "Silence gate threshold").
10. **No dead ends.** Missing media, denied permissions or an offline Claude each come with a clear message and a way to fix it.

## Stack

Electron, React and TypeScript for the app; WebCodecs and WebGL2 for one engine shared by preview and export; a small Swift helper for Apple-only features; ffmpeg and whisper.cpp as local sidecars.

| Layer | Choice | Why |
|---|---|---|
| Shell | Electron, electron-vite, electron-builder | Chromium gives consistent WebCodecs, WebGL2, getUserMedia, MediaRecorder and AudioWorklet, and several windows (the teleprompter is its own). |
| UI | React, TypeScript (strict), Zustand and Immer | A fast way to build a rich, inspector-heavy UI. |
| Media read/write | Mediabunny (WebCodecs-based demux and mux) | Pure TypeScript, frame-accurate, no native addon. |
| Decode/encode | WebCodecs with VideoToolbox | Hardware H.264/HEVC decode and encode in process, the same pixels in preview and export. |
| Compositor | WebGL2 shaders | Transforms, colour, LUTs, keying, blur, masks, text as textures. |
| Audio | Web Audio and an AudioWorklet mixer | Sample-accurate mixing, gain automation, ducking. |
| Native helper | Swift 6 CLI `director-native` (JSON lines over stdio) | On-device speech for voice-follow, ScreenCaptureKit screen recording that leaves out the prompter window, Vision for person segmentation, face and lip tracking. |
| Sidecars | ffmpeg/ffprobe, whisper.cpp (`whisper-cli`, Metal) | Probing, proxies, loudness, stabilisation, denoise, shot detection, transcription. |
| Library | SQLite (better-sqlite3) | Brands, reference reels, scripts, hooks, takes. |
| AI | `@anthropic-ai/sdk` in the main process, key in the macOS Keychain (Electron safeStorage) | Script drafting and the Director edit pass, text only. |
| Agent control | MCP server and REST on 127.0.0.1 behind a token | Lets Claude Code, Claude Desktop or any MCP client drive every edit. See [AGENTS.md](AGENTS.md). |
| In-app assistant | A Claude tool-use loop in the renderer, one model step per IPC call to the main process | The same tool catalog from a chat panel; the key and the request stay in the main process, and the privacy guard checks every step. |
| Tests | Vitest for packages, Playwright for the Electron app, golden frames and ffprobe checks | Checks in `scripts/verify/checks` print a PASS marker only after every assertion holds. |

Alternatives considered:

- **Native Swift and AVFoundation only.** Best raw performance, but a timeline and inspector-heavy UI in SwiftUI is far slower to build and change. Swift is still used where Apple frameworks are uniquely good, behind a narrow interface.
- **Tauri (WKWebView).** Smaller, but WKWebView's WebCodecs, MediaRecorder and screen capture support is narrower than Chromium's, so the editor would need a separate native media engine.
- **Forking an open-source editor.** Mature engines, but large Qt/C++ codebases with no teleprompter, transcript editing or AI hooks. A clean start on a focused workflow was less total work.
- **ffmpeg for live preview.** Great for batch jobs, but it cannot give interactive, frame-accurate scrubbing, so it stays a sidecar.

## Processes

```
+------------------------------- Electron main process ---------------------------------+
|  Windows (studio, teleprompter)          Job runner: ffmpeg | ffprobe | whisper-cli |  |
|                                          director-native (spawn, progress, cancel)    |
|  Project store: autosave, journal,       Library DB (SQLite)                          |
|  migrations                              Claude client (Keychain key, usage log)      |
|  MCP / REST server (opt-in, 127.0.0.1)    Files: browse, search, thumbnails, watcher  |
+-------------------------------- typed IPC (zod-validated) ----------------------------+
|  Renderer (React)                                                                     |
|   Swipe | Script | Record | Edit | Export workspaces, command palette, inspector      |
|   Engine: timeline model, edit ops, undo        Compositor (WebGL2)                   |
|   Decoder pool (WebCodecs) and frame cache      Audio engine (AudioWorklet mixer)     |
+---------------------------------------------------------------------------------------+
   Teleprompter window: always on top, excluded from screen capture
   director-native (Swift): listen | screen-record | segment | faces | devices | version
```

## Design rules

1. **Everything is an edit op.** The project document changes only through serializable, invertible operations. The UI, undo and redo, AutoCut, Make Reel, the Claude Director and the agent tools all emit the same ops, so there is one code path and one set of tests, and AI output is validated against a strict schema before anything changes.
2. **One renderer for preview and export.** Export runs the compositor used for preview, frame by frame, offline. Golden-frame tests hold it to that.
3. **Audio is the master clock.** Video frames are presented against the audio clock; late frames are dropped rather than allowed to drift.
4. **Proxies are automatic.** Media that is too heavy or that WebCodecs cannot decode gets a short-GOP H.264 proxy. Preview uses proxies; export always uses the originals.
5. **Heavy work never blocks the UI.** Transcription, proxies, analysis and export run as cancellable jobs with progress.
6. **The native helper is replaceable.** It speaks versioned JSON lines over stdio, so any capability can later get a cross-platform fallback without touching the app.
7. **Browsing stays inside folders the person opened.** The Files panel lists and searches only folders chosen in it (remembered in settings), and the `browse_files` agent tool goes through the same check, so an agent cannot wander the disk.

## Data model

**Time** is an integer number of microseconds everywhere, snapped to the project frame grid on edit. Integer maths avoids float drift.

**A project** is a folder bundle, `My Reel.director/`:

```
project.json     the project document (schema-versioned, zod-validated)
journal.jsonl    append-only op log since the last full save (crash recovery)
state.json       the journal sequence number the last save includes
cache/           proxies, waveforms, thumbnails, transcripts, analysis (safe to delete)
takes/           recordings made in this project
```

**The project document** (abridged; the full schema is `packages/engine/src/schema/project.ts`):

```ts
interface Project {
  schemaVersion: number;
  id: string;
  name: string;
  canvas: { width: number; height: number; fps: { num: number; den: number }; background: Fill; sampleRate: number };
  brandId?: string;
  media: Record<MediaId, MediaRef>;            // path, content hash, probe data, proxy
  lanes: Lane[];                                // ordered and typed
  markers: Marker[];                            // retakes, cues, chapters, beats
  scriptRef?: { scriptId: string; version: number };
  transcript?: TranscriptTrack[];
  settings: { snapping: boolean; rippleByDefault: boolean; safeZone: 'none' | 'reels' | 'tiktok' | 'shorts' };
}

type LaneKind = 'graphics' | 'titles' | 'captions' | 'broll' | 'screen' | 'camera' | 'voice' | 'music' | 'sfx';

interface Clip {
  id: ClipId;
  kind: 'media' | 'text' | 'caption' | 'shape' | 'adjustment' | 'placeholder';
  mediaId?: MediaId;                            // media clips only
  start: Micros;                                // position on the timeline
  in: Micros; out: Micros;                      // source range
  speed: SpeedSpec;                             // constant or ramp
  transform: Animatable<Transform>;             // position, scale, rotation, crop, opacity
  effects: Effect[];                            // colour, LUT, blur, key, mask, zoom...
  audio?: ClipAudio;                            // gain, fades, ducking
  text?: TextStyle;                             // text and caption clips, with word timing
  transitionIn?: { type: string; duration: Micros };
  linkGroup?: string;                           // linked audio and video
  meta?: Record<string, unknown>;               // provenance, e.g. which tool placed it
}
```

**Edit ops** are a discriminated union validated by zod. Each applies to a document and returns its inverse; undo is the inverse stack, and the journal stores ops so a crash replays to the last change.

**The library** (SQLite) holds brands, voice profiles, reference reels and their analysis (shots, words, structure), scripts and versions, hooks, takes, exports and the Claude usage log.

**A take** recorded with the teleprompter is a folder with the camera, microphone and optional screen files, plus `take.json`: the script version, devices, clock offsets, markers (retake, cue, good, bad) and the voice-follow alignment.
