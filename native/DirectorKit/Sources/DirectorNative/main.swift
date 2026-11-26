import Foundation

// director-native: JSON-lines helper for Apple-only capabilities.
// Protocol: one JSON object per line on stdout; errors as {"error": "..."} plus nonzero exit.
let protocolVersion = 1
let toolVersion = "0.1.0"

func emit(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
          let line = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["error": message])
    exit(code)
}

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("usage: director-native <version|devices|listen|screen-record|segment|faces> [options]", code: 2)
}
let rest = Array(args.dropFirst())

func option(_ name: String, in list: [String]) -> String? {
    guard let i = list.firstIndex(of: name), i + 1 < list.count else { return nil }
    return list[i + 1]
}

switch command {
case "version":
    let v = ProcessInfo.processInfo.operatingSystemVersion
    emit(["name": "director-native", "version": toolVersion, "protocol": protocolVersion,
          "macos": "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"])
case "devices":
    listDevices()
case "listen":
    runListen(rest)
case "screen-record":
    runScreenRecord(rest)
case "screen-sources":
    runScreenSources()
case "segment":
    runSegment(rest)
case "faces":
    runFaces(rest)
default:
    fail("unknown command: \(command)", code: 2)
}
