import SwiftUI

enum AvatarPalette {
    static let shapes = ["diamond", "circle", "pebble", "square", "pill", "triangle", "hexagon", "cloud", "drop"]
    static let colors = [
        (name: "White", value: "#ffffff"), (name: "Brown", value: "#895e34"),
        (name: "Red", value: "#ee1734"), (name: "Orange", value: "#ff6a00"),
        (name: "Amber", value: "#ff9c00"), (name: "Green", value: "#00a56a"),
        (name: "Teal", value: "#00ad9c"), (name: "Blue", value: "#087ee7"),
        (name: "Purple", value: "#8247e5"), (name: "Pink", value: "#e82692"),
        (name: "Gray", value: "#777777"),
    ]
    static let defaultAvatar = BotAvatar(shape: "hexagon", color: "#777777", image: nil)
}

@MainActor
private enum AvatarImages {
    static let cache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 128
        return cache
    }()

    static func image(_ value: String?) -> NSImage? {
        guard let value else { return nil }
        if let cached = cache.object(forKey: value as NSString) { return cached }
        let image: NSImage?
        if value == "/teal-bot.png" {
            let packaged = Bundle.main.resourceURL?
                .appendingPathComponent("BunjiBoxMac_BunjiBoxMac.bundle")
            let resources = packaged.flatMap(Bundle.init(url:)) ?? Bundle.module
            image = resources.url(forResource: "teal-bot", withExtension: "png").flatMap(NSImage.init(contentsOf:))
        } else if value.hasPrefix("data:image/"), let comma = value.firstIndex(of: ","),
                  let data = Data(base64Encoded: String(value[value.index(after: comma)...])) {
            image = NSImage(data: data)
        } else { image = nil }
        if let image { cache.setObject(image, forKey: value as NSString) }
        return image
    }
}

struct AvatarView: View {
    let avatar: BotAvatar
    let size: CGFloat
    var body: some View {
        Group {
            if let image = AvatarImages.image(avatar.image) {
                Image(nsImage: image).resizable().scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.25))
            } else {
                ZStack {
                    BotSilhouette(name: avatar.shape).fill(Color(hex: avatar.color))
                    let eyeY: CGFloat = avatar.shape == "triangle" ? 57 : avatar.shape == "drop" ? 54 : 43
                    let eyeX: CGFloat = avatar.shape == "triangle" ? 70 : avatar.shape == "drop" ? 73 : 77
                    Ellipse().fill(Color.black.opacity(0.9))
                        .frame(width: size * 0.082, height: size * 0.166)
                        .rotationEffect(.degrees(-18)).position(x: size * 0.54, y: size * eyeY / 100)
                    Ellipse().fill(Color.black.opacity(0.9))
                        .frame(width: size * 0.082, height: size * 0.166)
                        .rotationEffect(.degrees(-18)).position(x: size * eyeX / 100, y: size * (eyeY - 4) / 100)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(avatar.image == nil ? "\(avatar.shape.capitalized) avatar" : "Custom profile picture")
    }
}

// Matches the nine silhouettes in the web avatar picker, in a 100-point square.
struct BotSilhouette: Shape {
    let name: String
    func path(in rect: CGRect) -> Path {
        var p = Path()
        func move(_ x: CGFloat, _ y: CGFloat) { p.move(to: CGPoint(x: x, y: y)) }
        func line(_ x: CGFloat, _ y: CGFloat) { p.addLine(to: CGPoint(x: x, y: y)) }
        func quad(_ x: CGFloat, _ y: CGFloat, _ cx: CGFloat, _ cy: CGFloat) {
            p.addQuadCurve(to: CGPoint(x: x, y: y), control: CGPoint(x: cx, y: cy))
        }
        func curve(_ x: CGFloat, _ y: CGFloat, _ c1x: CGFloat, _ c1y: CGFloat, _ c2x: CGFloat, _ c2y: CGFloat) {
            p.addCurve(to: CGPoint(x: x, y: y), control1: CGPoint(x: c1x, y: c1y), control2: CGPoint(x: c2x, y: c2y))
        }
        switch name {
        case "diamond": move(50, 4); line(96, 50); line(50, 96); line(4, 50)
        case "circle": p.addEllipse(in: CGRect(x: 8, y: 8, width: 84, height: 84))
        case "pebble":
            move(57, 11); curve(91, 46, 75, 11, 86, 26); curve(58, 90, 98, 68, 82, 89)
            curve(8, 58, 34, 92, 10, 79); curve(57, 11, 6, 36, 30, 11)
        case "square": p.addRoundedRect(in: CGRect(x: 12, y: 12, width: 76, height: 76), cornerSize: CGSize(width: 20, height: 20))
        case "pill": p.addRoundedRect(in: CGRect(x: 5, y: 21, width: 90, height: 58), cornerSize: CGSize(width: 29, height: 29))
        case "triangle":
            move(41, 15); quad(59, 15, 50, 1); line(91, 73); quad(80, 92, 102, 92)
            line(20, 92); quad(9, 73, -2, 92)
        case "cloud":
            move(19, 40); curve(49, 18, 13, 19, 34, 8); curve(84, 39, 69, 8, 86, 21)
            curve(78, 79, 103, 49, 97, 76); curve(40, 82, 65, 91, 49, 90)
            curve(5, 60, 22, 91, 3, 78); curve(19, 40, 5, 50, 10, 43)
        case "drop":
            move(46, 7); quad(54, 7, 50, 1); curve(87, 58, 64, 21, 85, 41)
            curve(52, 97, 91, 81, 75, 97); curve(14, 61, 28, 97, 12, 82)
            curve(46, 7, 15, 43, 35, 21)
        default:
            move(42, 5); quad(58, 5, 50, 0); line(85, 21); quad(92, 35, 92, 25)
            line(92, 65); quad(85, 79, 92, 75); line(58, 95); quad(42, 95, 50, 100)
            line(15, 79); quad(8, 65, 8, 75); line(8, 35); quad(15, 21, 8, 25)
        }
        p.closeSubpath()
        return p.applying(CGAffineTransform(scaleX: rect.width / 100, y: rect.height / 100))
            .applying(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }
}
