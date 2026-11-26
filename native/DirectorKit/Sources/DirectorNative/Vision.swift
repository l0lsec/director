import AVFoundation
import CoreImage
import Foundation
import Vision

// faces --file <video> [--every 3] [--mouth]
//   Emits {"t":seconds,"faces":[{"x","y","w","h"}]} per analyzed frame (normalized, top-left origin), then {"done":true}.
//   --mouth adds "m" per face: the inner-lip opening as a fraction of the face height (for who is speaking).
// segment --file <video> --out <matte.mov> [--quality balanced|accurate|fast]
//   Writes a grayscale person matte (white = person) as an H.264 movie with the source's timing.

func videoReader(_ path: String) throws -> (AVAssetReader, AVAssetReaderTrackOutput, AVAssetTrack) {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    guard let track = asset.tracks(withMediaType: .video).first else { throw NSError(domain: "director", code: 1, userInfo: [NSLocalizedDescriptionKey: "no video track"]) }
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    out.alwaysCopiesSampleData = false
    reader.add(out)
    return (reader, out, track)
}

func orientation(_ track: AVAssetTrack) -> CGImagePropertyOrientation {
    let t = track.preferredTransform
    if t.a == 0 && t.b == 1 && t.c == -1 && t.d == 0 { return .right }
    if t.a == 0 && t.b == -1 && t.c == 1 && t.d == 0 { return .left }
    if t.a == -1 && t.d == -1 { return .down }
    return .up
}

func runFaces(_ args: [String]) {
    guard let file = option("--file", in: args) else { fail("--file is required", code: 2) }
    let every = Int(option("--every", in: args) ?? "3") ?? 3
    let mouth = args.contains("--mouth")
    do {
        let (reader, out, track) = try videoReader(file)
        let orient = orientation(track)
        reader.startReading()
        var n = 0
        while let sample = out.copyNextSampleBuffer() {
            defer { n += 1 }
            if n % every != 0 { continue }
            guard let px = CMSampleBufferGetImageBuffer(sample) else { continue }
            let t = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            let faces: [[String: Double]]
            if mouth {
                // Landmarks also find the faces; m = inner-lip opening as a fraction of the face height.
                let req = VNDetectFaceLandmarksRequest()
                try VNImageRequestHandler(cvPixelBuffer: px, orientation: orient).perform([req])
                faces = (req.results ?? []).map { f in
                    let b = f.boundingBox
                    var o: [String: Double] = ["x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height, "c": Double(f.confidence)]
                    if let lips = f.landmarks?.innerLips, lips.pointCount > 2 {
                        let ys = lips.normalizedPoints.map { Double($0.y) }
                        o["m"] = (ys.max()! - ys.min()!)
                    }
                    return o
                }
            } else {
                let req = VNDetectFaceRectanglesRequest()
                try VNImageRequestHandler(cvPixelBuffer: px, orientation: orient).perform([req])
                faces = (req.results ?? []).map { f in
                    let b = f.boundingBox
                    return ["x": b.minX, "y": 1 - b.maxY, "w": b.width, "h": b.height, "c": Double(f.confidence)]
                }
            }
            emit(["t": t, "faces": faces])
        }
        emit(["done": true, "frames": n])
        exit(0)
    } catch {
        fail("faces failed: \(error.localizedDescription)", code: 7)
    }
}

func runSegment(_ args: [String]) {
    guard let file = option("--file", in: args), let outPath = option("--out", in: args) else { fail("--file and --out are required", code: 2) }
    let quality = option("--quality", in: args) ?? "balanced"
    do {
        let (reader, out, track) = try videoReader(file)
        let size = track.naturalSize.applying(track.preferredTransform)
        let w = Int(abs(size.width)), h = Int(abs(size.height))
        let url = URL(fileURLWithPath: outPath)
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 8_000_000]])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: w, kCVPixelBufferHeightKey as String: h])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        reader.startReading()
        let ctx = CIContext()
        let orient = orientation(track)
        var frames = 0
        while let sample = out.copyNextSampleBuffer() {
            guard let px = CMSampleBufferGetImageBuffer(sample) else { continue }
            let t = CMSampleBufferGetPresentationTimeStamp(sample)
            let req = VNGeneratePersonSegmentationRequest()
            req.qualityLevel = quality == "accurate" ? .accurate : quality == "fast" ? .fast : .balanced
            req.outputPixelFormat = kCVPixelFormatType_OneComponent8
            try VNImageRequestHandler(cvPixelBuffer: px, orientation: orient).perform([req])
            guard let mask = req.results?.first?.pixelBuffer else { continue }
            var img = CIImage(cvPixelBuffer: mask)
            img = img.transformed(by: CGAffineTransform(scaleX: CGFloat(w) / img.extent.width, y: CGFloat(h) / img.extent.height))
            while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
            guard let pool = adaptor.pixelBufferPool else { continue }
            var outBuf: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outBuf)
            guard let ob = outBuf else { continue }
            ctx.render(img, to: ob)
            adaptor.append(ob, withPresentationTime: t)
            frames += 1
            if frames % 30 == 0 { emit(["progress": frames]) }
        }
        input.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
        if writer.status != .completed { fail("matte write failed: \(writer.error?.localizedDescription ?? "unknown")", code: 7) }
        emit(["done": true, "frames": frames, "out": outPath])
        exit(0)
    } catch {
        fail("segment failed: \(error.localizedDescription)", code: 7)
    }
}
