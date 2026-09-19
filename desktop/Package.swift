// swift-tools-version: 6.0
// The ClosedHand desktop app: the menu-bar shell that runs the whole stack
// (Postgres, the bot, the webapp) on this Mac. It grows out of the Bridge app
// and keeps its bundle identity, so a Mac that already trusts Bridge keeps
// trusting this. The Docker path in the repo root is untouched by it.
import PackageDescription

let package = Package(
    name: "ClosedHand",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ClosedHand",
            path: "Sources/ClosedHand",
            resources: [.copy("Resources/logo.png")],
            swiftSettings: [
                .swiftLanguageMode(.v5)
            ]
        )
    ]
)
