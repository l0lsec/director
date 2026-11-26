// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "DirectorKit",
    platforms: [.macOS("26.0")],
    products: [.executable(name: "director-native", targets: ["DirectorNative"])],
    targets: [
        .executableTarget(
            name: "DirectorNative",
            path: "Sources/DirectorNative",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
