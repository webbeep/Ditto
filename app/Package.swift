// swift-tools-version:5.9
// Ditto for macOS: a WebKit browser with the agent built in. Built and
// bundled by scripts/build-app.sh.
import PackageDescription

let package = Package(
  name: "Ditto",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "Ditto",
      path: "Sources/Ditto",
      linkerSettings: [.linkedLibrary("sqlite3")]
    ),
  ]
)
