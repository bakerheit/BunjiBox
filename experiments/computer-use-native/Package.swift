// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ComputerUseNativeSpike",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ComputerUseNativeSpike", targets: ["ComputerUseNativeSpike"]),
        .executable(name: "ComputerUseNativeSpikeChecks", targets: ["ComputerUseNativeSpikeChecks"]),
        .executable(name: "BunjiNativeLab", targets: ["BunjiNativeLab"])
    ],
    targets: [
        .target(name: "ComputerUseNativeSpike"),
        .executableTarget(name: "BunjiNativeLab", dependencies: ["ComputerUseNativeSpike"]),
        .executableTarget(
            name: "ComputerUseNativeSpikeChecks",
            dependencies: ["ComputerUseNativeSpike"],
            path: "Checks"
        )
    ]
)
