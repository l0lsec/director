# Director

A desktop video studio for talking-head content on the Mac: write the script, read it off a teleprompter that sits under your webcam while you record, and let the app cut, caption, frame and export the video. Short-form reels and long-form YouTube episodes both work. Everything runs on your Mac; no subscription, no upload.

Director is also built to be driven by AI. Chat with Claude in the app's Assistant panel, or plug in Claude Code, Claude Desktop or any MCP client: either way it can run every editing operation (97 tools), with your approval or on its own, and every change is one undo step.

## What it does

Five workspaces, in the order you work:

- **Swipe**: a library of reference reels per brand. Import a reel (file or link), and Director measures its pacing (shots, cuts per minute, words per second) and labels its structure (hook, setup, payoff, call to action).
- **Script**: write or draft scripts, keep versions, pick hooks, and see the runtime at your own reading speed.
- **Record**: a desktop teleprompter in its own always-on-top window, placed under the camera so your eyes stay on the lens. It follows your voice as you read. Records camera, microphone and optionally the screen.
- **Edit**: a lane-based timeline (camera, screen, b-roll, titles, captions, voice, music, sound effects) with text-based editing on the transcript:
  - **Cutting**: AutoCut removes pauses, fillers and retakes; one-click Make Reel builds a first cut from a recording.
  - **Speaker layout**: for interviews and podcasts, including split-screen remote recordings. It cuts to whoever is talking from lip movement, shows both people during quick exchanges and reactions, and alternates framing in long answers.
  - **Look and sound**: captions with styles; titles, lower thirds and shapes; colour, LUTs, zoom, shake, blur, masks, chroma key and background removal; speed ramps; transitions; keyframes; music ducking under the voice; beat markers; voice clean-up.
- **Export**: H.264 or HEVC presets for Reels, Shorts and YouTube, loudness-normalised to -14 LUFS, plus SRT/VTT subtitles, stills and a YouTube chapter list.

## Requirements

- A Mac with Apple Silicon, running macOS 26 or later.
- Xcode 26 (Swift 6) to build the native helper.
- Node 22 or later (24 recommended) and pnpm 11.
- From Homebrew: `ffmpeg` and `whisper-cpp`; optionally `yt-dlp` to import reference reels from links.

```bash
brew install ffmpeg whisper-cpp yt-dlp
```

To check that everything is in place:

```bash
node scripts/probe-toolchain.mjs
```

## Build and run

```bash
pnpm install
```

```bash
cd native/DirectorKit && swift build -c release && cd ../..
```

```bash
pnpm dev
```

The first time you transcribe, Director offers to download a whisper.cpp model (Settings > Transcription). It also finds models already in `~/.cache/whisper`. Large v3 Turbo gives the best transcripts; Small (English) is faster and smaller.

Claude features (script drafting, the Director edit pass) need your own Anthropic API key, entered in Settings and stored in the macOS Keychain. Everything else works without one.

## Package a standalone app

```bash
node scripts/release/package.mjs
```

This builds `apps/desktop/release/mac-arm64/Director.app` with ffmpeg, whisper.cpp and the native helper bundled inside, so it runs on a Mac without Homebrew. The bundled tools come from Homebrew, which builds them for the macOS version they were installed on, so the packaged app requires that macOS version or later; the script sets the app's minimum system version to match. It is signed ad hoc, which is enough for the Mac that built it. With a Developer ID Application certificate in your keychain, the same command signs it with the hardened runtime. If a `notarytool` keychain profile named `director-notary` exists, it also notarizes the app.

A downloaded, unsigned copy is blocked by Gatekeeper the first time. Right-click it and choose Open, or run:

```bash
xattr -dr com.apple.quarantine Director.app
```

## Edit by chatting

Open the **Assistant** panel in the Edit workspace (Cmd+J) and say what you want in your own words: "remove the long pauses", "cut to whoever is talking", "add a title over the hook and captions for the whole thing". Claude reads the timeline and transcript, makes the edits with the same tools external assistants use, and tells you what changed. It uses your Anthropic API key from Settings.

The Ask and Auto modes below apply here too, and every change is one undo step. Pictures, file paths and file names stay on your Mac, so the built-in assistant cannot look at frames or import files. Drag media in yourself, or connect Claude Desktop or Claude Code if you want an assistant that can see frames.

## Connect an AI assistant

In Director, open Settings (Cmd+,), turn on **Connect an AI**, and copy the setup for your app: a one-line command for Claude Code, a config entry for Claude Desktop, or an HTTP endpoint for other MCP clients and plain REST. It listens on 127.0.0.1 only, behind a token.

In Ask mode every change waits for your approval. In Auto mode changes apply at once, and the Agent panel can revert all of an assistant's changes in one step. The full tool reference is in [docs/AGENTS.md](docs/AGENTS.md).

## Develop

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm fixtures
```

```bash
node scripts/verify/run.mjs node-8-e2e
```

`pnpm fixtures` generates the synthetic test media (ffmpeg test patterns and macOS speech synthesis) into `fixtures/media`. The end-to-end checks in `scripts/verify/checks` launch the real app under Playwright. They use a temporary profile and a mock keychain, so they never touch your projects or your Keychain.

The code keeps to TypeScript that Node can run by stripping types (`erasableSyntaxOnly`), so scripts run under plain `node` without a build step. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the pieces fit together and the rules the code keeps to.

| Path | What it is |
|---|---|
| `apps/desktop` | The Electron app: main process (media jobs, transcription, MCP server, storage) and React renderer |
| `packages/engine` | Project model, edit operations with exact undo, effect and export catalogs |
| `packages/media` | Decoding, WebGL compositor, audio mixing, export |
| `packages/analysis` | Transcript timing, AutoCut, captions, pacing, script alignment, speaker detection |
| `packages/ai` | Claude client with a privacy guard and the Director edit pass |
| `packages/agent` | The tool catalog AI assistants use (MCP, REST) |
| `packages/library` | SQLite library: brands, references, scripts, hooks, takes |
| `native/DirectorKit` | Swift helper for Apple-only features: capture devices, on-device speech, face and lip tracking, person segmentation, screen recording |

## Privacy

Media never leaves your Mac. Transcription, face tracking and background removal run on device. When Claude features are used, including the Assistant chat, only text goes to Anthropic (script text, your chat messages, transcript words, timings and a text description of the timeline). A privacy guard blocks file paths, file names and media from every request, and Settings shows a usage log of each call (task, tokens, cost).

## Licenses of bundled tools

A packaged Director.app includes FFmpeg built with GPL components (including x264), so FFmpeg in a distributed build is under the GPL. If you share packaged builds, include FFmpeg's license and offer its source. whisper.cpp is MIT licensed.

## License

Director is released under the [MIT License](LICENSE). Bundled tools in packaged builds keep their own licenses (see above).
