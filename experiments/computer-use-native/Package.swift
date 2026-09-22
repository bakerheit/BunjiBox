// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ComputerUseNativeSpike",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ComputerUseNativeSpike", targets: ["ComputerUseNativeSpike"]),
        .executable(name: "ComputerUseNativeSpikeChecks", targets: ["ComputerUseNativeSpikeChecks"])
    ],
    targets: [
        .target(name: "ComputerUseNativeSpike"),
        .executableTarget(
            name: "ComputerUseNativeSpikeChecks",
            dependencies: ["ComputerUseNativeSpike"],
            path: "Checks"
        )
    ]
)
