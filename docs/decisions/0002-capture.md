# 0002: Camera and microphone capture path

Status: accepted (2026-11-24)

## Decision

Record camera and microphone in the renderer with Chromium's `MediaRecorder` writing MP4 (H.264 High + AAC), streamed to disk in 500 ms chunks that are fsynced as they arrive. Screen capture runs in the native helper (`director-native screen-record`, ScreenCaptureKit recording output) so the prompter window can be excluded. A native AVFoundation camera recorder was not built.

## Measurements (spike S1, Apple M1 Max, Electron 45.3, macOS 27.2)

| Measure | Result | Source |
|---|---|---|
| Container written by MediaRecorder | Fragmented MP4: `ftyp`, `moov`, then `moof`/`mdat` pairs | box scan of a 10 s take |
| Crash safety | SIGKILL of the whole app 30 s into a take left 29.70 s of decodable video | `l1.1-crashsafe` |
| Frame accuracy | 3601 frames for 120.03 s at 30 fps (exact), 901 for 30.03 s | `l1.1-sync`, `l1.1-tracks` |
| Track alignment | audio 120.024 s vs video 120.031 s over a 2-minute take (7.6 ms) | `l1.1-tracks` |
| Flash/beep drift with fake devices | 255.6 ms over 120 s, caused by the fake sources' own clocks (flashes every 1.00336 s, beeps every 1.00077 s) | `l1.1-sync` |
| Constant offset with fake devices | about -55 ms (fake camera and mic start independently) | `l1.1-sync` |
| Device coverage | FaceTime HD and iPhone Continuity Camera, both microphones, matched by name to the native list | `l1.1-devices` |

## Why not native AVFoundation

The plan said native wins only if Chromium drifts more than a frame or drops frames at 4K30. The recorder itself showed exact frame counts and track lengths within a frame; the measured drift traced to the fake test sources. Native capture would add a second camera owner and an IPC video path for preview with no measured benefit.

## Follow-ups

- Real-hardware check: clap at the start and end of a 2-minute take; enter any constant offset in Record > Audio sync (ms).
- Screen-recording offsets (leaf 1.1 G4) need macOS Screen Recording permission for the app.
