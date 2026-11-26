import AVFoundation
import Foundation
import Speech

// listen [--file <audio>] [--stdin] [--realtime] [--locale en-US]
//   Streams on-device speech recognition as JSON lines:
//   {"type":"ready"} {"type":"partial"|"final","text":"...","start":s,"end":s,"wall":<unix ms>} {"type":"done"}
//   --stdin reads raw PCM s16le mono 16 kHz from standard input (what the app's mic pipeline sends).
//   --file reads an audio file; with --realtime it is fed at playback speed (for latency tests).

final class Feeder {
    let continuation: AsyncStream<AnalyzerInput>.Continuation
    let format: AVAudioFormat
    var converter: AVAudioConverter?
    init(continuation: AsyncStream<AnalyzerInput>.Continuation, format: AVAudioFormat) {
        self.continuation = continuation
        self.format = format
    }

    var fedSeconds: Double = 0
    func level(_ buffer: AVAudioPCMBuffer) {
        let n = Int(buffer.frameLength)
        guard n > 0 else { return }
        var sum: Double = 0
        if let f = buffer.floatChannelData?[0] {
            for i in 0..<n { let v = Double(f[i]); sum += v * v }
        } else if let s = buffer.int16ChannelData?[0] {
            for i in 0..<n { let v = Double(s[i]) / 32768; sum += v * v }
        }
        fedSeconds += Double(n) / buffer.format.sampleRate
        emit(["type": "level", "rms": (sum / Double(n)).squareRoot(), "t": fedSeconds, "wall": Date().timeIntervalSince1970 * 1000])
    }

    func feed(_ buffer: AVAudioPCMBuffer) {
        level(buffer)
        if buffer.format == format { continuation.yield(AnalyzerInput(buffer: buffer)); return }
        if converter == nil || converter!.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: format)
        }
        guard let converter else { return }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var consumed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if consumed { status.pointee = .noDataNow; return nil }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if err == nil && out.frameLength > 0 { continuation.yield(AnalyzerInput(buffer: out)) }
    }

    func finish() { continuation.finish() }
}

func textOf(_ s: AttributedString) -> String { String(s.characters) }

func runListen(_ args: [String]) {
    let localeId = option("--locale", in: args) ?? "en-US"
    let file = option("--file", in: args)
    let useStdin = args.contains("--stdin")
    let realtime = args.contains("--realtime")
    let fast = !args.contains("--accurate")

    Task {
        do {
            let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) ?? Locale(identifier: localeId)
            let engineName = option("--engine", in: args) ?? "dictation"
            let module: any SpeechModule
            let installModules: [any SpeechModule]
            var resultsTask: Task<Void, Never>
            func report(_ text: AttributedString, _ range: CMTimeRange, _ isFinal: Bool) {
                let start = range.start.seconds
                let end = CMTimeRangeGetEnd(range).seconds
                emit(["type": isFinal ? "final" : "partial", "text": textOf(text),
                      "start": start.isFinite ? start : 0, "end": end.isFinite ? end : 0,
                      "wall": Date().timeIntervalSince1970 * 1000])
            }
            if engineName == "transcriber" {
                let t = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: fast ? [.volatileResults, .fastResults] : [.volatileResults], attributeOptions: [.audioTimeRange])
                module = t; installModules = [t]
                resultsTask = Task {
                    do { for try await r in t.results { report(r.text, r.range, r.isFinal) } } catch { emit(["error": "results: \(error.localizedDescription)"]) }
                }
            } else {
                var reporting: Set<DictationTranscriber.ReportingOption> = [.volatileResults]
                if !args.contains("--no-frequent-final") { reporting.insert(.frequentFinalization) }
                var hints: Set<DictationTranscriber.ContentHint> = []
                if args.contains("--short-form") { hints.insert(.shortForm) }
                let d = DictationTranscriber(locale: locale, contentHints: hints, transcriptionOptions: [], reportingOptions: reporting, attributeOptions: [.audioTimeRange])
                module = d; installModules = [d]
                resultsTask = Task {
                    do { for try await r in d.results { report(r.text, r.range, r.isFinal) } } catch { emit(["error": "results: \(error.localizedDescription)"]) }
                }
            }
            if let request = try await AssetInventory.assetInstallationRequest(supporting: installModules) {
                emit(["type": "installing", "locale": locale.identifier])
                try await request.downloadAndInstall()
            }
            guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: installModules) else {
                fail("no compatible audio format for speech analysis", code: 6)
            }
            let analyzer = SpeechAnalyzer(modules: [module])
            try await analyzer.prepareToAnalyze(in: format)
            let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
            let feeder = Feeder(continuation: continuation, format: format)

            try await analyzer.start(inputSequence: stream)
            emit(["type": "ready", "locale": locale.identifier, "sampleRate": format.sampleRate, "wall": Date().timeIntervalSince1970 * 1000])

            // Warm-up: feed silence first, as the app does during the 3-2-1 countdown.
            let warmup = Double(option("--warmup", in: args) ?? "0") ?? 0
            if warmup > 0, let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(format.sampleRate * 0.1)) {
                silence.frameLength = silence.frameCapacity
                let start = Date()
                var fed = 0.0
                while fed < warmup {
                    feeder.feed(silence)
                    fed += 0.1
                    if realtime { let ahead = fed - Date().timeIntervalSince(start); if ahead > 0 { try await Task.sleep(nanoseconds: UInt64(ahead * 1e9)) } }
                }
                emit(["type": "warm", "seconds": warmup, "wall": Date().timeIntervalSince1970 * 1000])
            }
            if let file {
                try await feedFile(path: file, feeder: feeder, realtime: realtime)
            } else if useStdin {
                feedStdin(feeder: feeder)
            } else {
                try feedMic(feeder: feeder)
                // Mic mode runs until stdin closes.
                while readLine() != nil {}
            }
            feeder.finish()
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            _ = await resultsTask.result
            emit(["type": "done"])
            exit(0)
        } catch {
            fail("listen failed: \(error.localizedDescription)", code: 6)
        }
    }
    dispatchMain()
}

func feedFile(path: String, feeder: Feeder, realtime: Bool) async throws {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    let format = file.processingFormat
    let chunk = AVAudioFrameCount(format.sampleRate / 20) // 50 ms
    let start = Date()
    var fed: Double = 0
    while file.framePosition < file.length {
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else { break }
        try file.read(into: buf, frameCount: chunk)
        if buf.frameLength == 0 { break }
        fed += Double(buf.frameLength) / format.sampleRate
        if realtime {
            let ahead = fed - Date().timeIntervalSince(start)
            if ahead > 0 { try await Task.sleep(nanoseconds: UInt64(ahead * 1_000_000_000)) }
        }
        feeder.feed(buf)
    }
}

func feedStdin(feeder: Feeder) {
    guard let fmt = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true) else { return }
    let handle = FileHandle.standardInput
    while true {
        let data = handle.readData(ofLength: 3200) // 100 ms
        if data.isEmpty { break }
        let frames = AVAudioFrameCount(data.count / 2)
        guard let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames) else { break }
        buf.frameLength = frames
        data.withUnsafeBytes { raw in
            if let src = raw.baseAddress { memcpy(buf.int16ChannelData![0], src, Int(frames) * 2) }
        }
        feeder.feed(buf)
    }
}

var micEngine: AVAudioEngine?

func feedMic(feeder: Feeder) throws {
    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    input.installTap(onBus: 0, bufferSize: 1600, format: format) { buf, _ in feeder.feed(buf) }
    try engine.start()
    micEngine = engine
}
