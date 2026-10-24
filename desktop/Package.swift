// swift-tools-version: 6.0
// The ClosedHand desktop app: the menu-bar shell that runs the whole stack
// (Postgres, the bot, the webapp) on this Mac. It grows out of the Bridge app
// and keeps its bundle identity, so a Mac that already trusts Bridge keeps
// trusting this. The Docker path in the repo root is untouched by it.
// Sparkle keeps it up to date (Sources/ClosedHand/Updater.swift).
import PackageDescription

let package = Package(
    name: "ClosedHand",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")
    ],
    targets: [
        .executableTarget(
            name: "ClosedHand",
            dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            path: "Sources/ClosedHand",
            resources: [.copy("Resources/logo.png")],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ],
            // Sparkle.framework sits in the app's Contents/Frameworks (build.sh).
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
        ),
        .executableTarget(
            name: "WorkspaceVM",
            path: "Sources/WorkspaceVM",
            swiftSettings: [.swiftLanguageMode(.v5)]
        )
    ]
)
