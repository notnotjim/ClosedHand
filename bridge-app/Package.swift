// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ClosedHandBridge",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ClosedHandBridge",
            path: "Sources",
            exclude: ["ClosedHandBridge.entitlements"],
            resources: [.copy("Resources/logo.png")],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
