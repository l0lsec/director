import AVFoundation
import Foundation
import ScreenCaptureKit

// screen-sources: list capturable displays and windows.
// screen-record --out <path.mov> [--display <id>] [--exclude-window <id>]... [--fps 30] [--cursor 1] [--codec hevc|h264]
//   Writes a movie with ScreenCaptureKit's recording output. Send "stop" on stdin to finish.
//   Events: {"event":"started","t":<unix ms>} {"event":"stopped","path":...} {"error":...}

func shareableContent() async throws -> SCShareableContent {
    try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
}

func runScreenSources() {
    Task {
        do {
            let content = try await shareableContent()
            for d in content.displays {
                emit(["kind": "display", "id": Int(d.displayID), "width": d.width, "height": d.height])
            }
            for w in content.windows where w.isOnScreen && w.frame.width > 80 && w.frame.height > 80 {
                emit(["kind": "window", "id": Int(w.windowID), "title": w.title ?? "", "app": w.owningApplication?.applicationName ?? "",
                      "bundleId": w.owningApplication?.bundleIdentifier ?? "", "width": Int(w.frame.width), "height": Int(w.frame.height)])
            }
            exit(0)
        } catch {
            fail("screen capture unavailable: \(error.localizedDescription). Grant Screen Recording permission in System Settings.", code: 4)
        }
    }
    dispatchMain()
}

final class ScreenSession: NSObject, SCStreamDelegate, SCRecordingOutputDelegate {
    var stream: SCStream?
    var recording: SCRecordingOutput?
    let url: URL
    var stopped = false

    init(url: URL) { self.url = url }

    func start(display: SCDisplay, exclude: [SCWindow], fps: Int, cursor: Bool, codec: AVVideoCodecType) async throws {
        let filter = SCContentFilter(display: display, excludingWindows: exclude)
        let config = SCStreamConfiguration()
        let scale = Int(filter.pointPixelScale)
        config.width = Int(filter.contentRect.width) * max(scale, 1)
        config.height = Int(filter.contentRect.height) * max(scale, 1)
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
        config.showsCursor = cursor
        config.queueDepth = 6
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        let rc = SCRecordingOutputConfiguration()
        rc.outputURL = url
        rc.outputFileType = .mov
        rc.videoCodecType = codec
        let recording = SCRecordingOutput(configuration: rc, delegate: self)
        try stream.addRecordingOutput(recording)
        self.stream = stream
        self.recording = recording
        try await stream.startCapture()
    }

    func stop() async {
        guard !stopped, let stream else { return }
        stopped = true
        do { try await stream.stopCapture() } catch { emit(["warning": "stopCapture: \(error.localizedDescription)"]) }
    }

    func recordingOutputDidStartRecording(_ recordingOutput: SCRecordingOutput) {
        emit(["event": "started", "t": Date().timeIntervalSince1970 * 1000])
    }

    func recordingOutputDidFinishRecording(_ recordingOutput: SCRecordingOutput) {
        emit(["event": "stopped", "path": url.path])
        exit(0)
    }

    func recordingOutput(_ recordingOutput: SCRecordingOutput, didFailWithError error: Error) {
        fail("recording failed: \(error.localizedDescription)", code: 5)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("stream stopped: \(error.localizedDescription)", code: 5)
    }
}

func runScreenRecord(_ args: [String]) {
    if args.first == "--list" { runScreenSources(); return }
    guard let out = option("--out", in: args) else { fail("--out is required", code: 2) }
    let fps = Int(option("--fps", in: args) ?? "30") ?? 30
    let cursor = (option("--cursor", in: args) ?? "1") != "0"
    let codec: AVVideoCodecType = (option("--codec", in: args) ?? "h264") == "hevc" ? .hevc : .h264
    var excludeIds = Set<UInt32>()
    for (i, a) in args.enumerated() where a == "--exclude-window" && i + 1 < args.count {
        if let v = UInt32(args[i + 1]) { excludeIds.insert(v) }
    }
    let displayId = option("--display", in: args).flatMap { UInt32($0) }
    let session = ScreenSession(url: URL(fileURLWithPath: out))
    let maxSeconds = Double(option("--max-seconds", in: args) ?? "0") ?? 0

    Task {
        do {
            let content = try await shareableContent()
            guard let display = content.displays.first(where: { displayId == nil || $0.displayID == displayId! }) ?? content.displays.first else {
                fail("no display to capture", code: 4)
            }
            let exclude = content.windows.filter { excludeIds.contains($0.windowID) }
            try await session.start(display: display, exclude: exclude, fps: fps, cursor: cursor, codec: codec)
            emit(["event": "capturing", "display": Int(display.displayID), "excluded": exclude.map { Int($0.windowID) }])
        } catch {
            fail("screen capture unavailable: \(error.localizedDescription). Grant Screen Recording permission in System Settings.", code: 4)
        }
    }
    // Stop on "stop" from stdin, on stdin EOF, or after --max-seconds.
    DispatchQueue.global().async {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
        }
        Task { await session.stop() }
    }
    if maxSeconds > 0 {
        DispatchQueue.global().asyncAfter(deadline: .now() + maxSeconds) { Task { await session.stop() } }
    }
    dispatchMain()
}
