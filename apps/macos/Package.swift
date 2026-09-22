// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "BunjiBoxMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "BunjiBoxMac", targets: ["BunjiBoxMac"])],
    targets: [.executableTarget(name: "BunjiBoxMac", resources: [.copy("Resources/teal-bot.png")])]
)
