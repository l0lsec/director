import AVFoundation
import Foundation

func listDevices() {
    let video = AVCaptureDevice.DiscoverySession(
        // Desk View is left out: browsers (and so the app) cannot open it as a camera.
        deviceTypes: [.builtInWideAngleCamera, .continuityCamera, .external],
        mediaType: .video, position: .unspecified).devices
    for d in video {
        var formats: [[String: Any]] = []
        var seen = Set<String>()
        for f in d.formats {
            let dims = CMVideoFormatDescriptionGetDimensions(f.formatDescription)
            let maxFps = f.videoSupportedFrameRateRanges.map { $0.maxFrameRate }.max() ?? 0
            let minFps = f.videoSupportedFrameRateRanges.map { $0.minFrameRate }.min() ?? 0
            let key = "\(dims.width)x\(dims.height)@\(maxFps)"
            if seen.contains(key) { continue }
            seen.insert(key)
            formats.append(["width": Int(dims.width), "height": Int(dims.height), "maxFps": maxFps, "minFps": minFps])
        }
        emit(["id": d.uniqueID, "name": d.localizedName, "kind": "video", "manufacturer": d.manufacturer,
              "modelId": d.modelID, "isContinuity": d.deviceType == .continuityCamera || d.modelID.hasPrefix("iPhone"), "formats": formats])
    }
    let audio = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
    for d in audio {
        emit(["id": d.uniqueID, "name": d.localizedName, "kind": "audio", "manufacturer": d.manufacturer, "modelId": d.modelID])
    }
}
