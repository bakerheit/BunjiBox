// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ComputerUseBrowserSpike",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "ComputerUseBrowserSpike", targets: ["ComputerUseBrowserSpike"]),
        .executable(name: "BrowserShellDemo", targets: ["BrowserShellDemo"])
    ],
    targets: [
        .executableTarget(name: "ComputerUseBrowserSpike"),
        .executableTarget(name: "BrowserShellDemo")
    ]
)
