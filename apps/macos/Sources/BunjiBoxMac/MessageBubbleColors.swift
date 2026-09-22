import Foundation

// Explicit sRGB surfaces keep the avatar tint subtle and text contrast predictable.
struct MessageRGB: Equatable {
    let red: Double
    let green: Double
    let blue: Double

    init(_ red: Double, _ green: Double, _ blue: Double) {
        self.red = red; self.green = green; self.blue = blue
    }

    init?(hex: String) {
        let value = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard value.count == 6, value.allSatisfy(\.isHexDigit), let number = UInt32(value, radix: 16) else { return nil }
        self.init(Double((number >> 16) & 255) / 255, Double((number >> 8) & 255) / 255, Double(number & 255) / 255)
    }

    func mixed(with other: MessageRGB, amount: Double) -> MessageRGB {
        MessageRGB(red * (1 - amount) + other.red * amount,
                   green * (1 - amount) + other.green * amount,
                   blue * (1 - amount) + other.blue * amount)
    }

    var luminance: Double {
        func linear(_ value: Double) -> Double { value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
    }

    func contrast(with other: MessageRGB) -> Double {
        (max(luminance, other.luminance) + 0.05) / (min(luminance, other.luminance) + 0.05)
    }
}

struct MessageBubbleColors {
    let background: MessageRGB
    let foreground: MessageRGB
    let secondary: MessageRGB

    init(avatarHex: String, isUser: Bool, isDark: Bool) {
        let neutral = MessageRGB(0.48, 0.48, 0.48)
        let avatar = MessageRGB(hex: avatarHex) ?? neutral
        let tint = min(avatar.red, avatar.green, avatar.blue) > 0.94 ? neutral : avatar
        let base = isDark ? MessageRGB(0.12, 0.12, 0.12) : MessageRGB(0.98, 0.98, 0.98)
        // The agent owns the accent. Human messages stay neutral across agents.
        background = isUser
            ? (isDark ? MessageRGB(0.21, 0.21, 0.21) : MessageRGB(0.90, 0.90, 0.90))
            : base.mixed(with: tint, amount: isDark ? 0.15 : 0.09)
        foreground = isDark ? MessageRGB(0.96, 0.96, 0.96) : MessageRGB(0.10, 0.10, 0.10)
        secondary = isDark ? MessageRGB(0.78, 0.78, 0.78) : MessageRGB(0.33, 0.33, 0.33)
    }
}
