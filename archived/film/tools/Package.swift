// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "rollsx",
    platforms: [.macOS(.v14)],
    targets: [
        .target(name: "RollsFilm", resources: [.copy("Resources")]),
        .executableTarget(name: "export", dependencies: ["RollsFilm"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
