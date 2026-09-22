import SwiftUI

// Mirrors packages/shared/src/avatars.js; all geometry uses a 100-point square.
enum DistinctAvatarShapes {
    static let names = ["comet", "sprout", "ribbon", "orbit", "lantern", "notched-tile"]
    static func label(_ name: String) -> String {
        switch name {
        case "comet": return "Comet"
        case "sprout": return "Sprout"
        case "ribbon": return "Folded ribbon"
        case "orbit": return "Orbit"
        case "lantern": return "Lantern"
        case "notched-tile": return "Notched tile"
        default: return name.capitalized
        }
    }
    static func aperture(_ name: String) -> CGPoint? {
        switch name {
        case "comet": return CGPoint(x: 61, y: 59)
        case "sprout": return CGPoint(x: 69, y: 33)
        case "ribbon": return CGPoint(x: 50, y: 50)
        case "orbit": return CGPoint(x: 51, y: 49)
        case "lantern": return CGPoint(x: 50, y: 52)
        case "notched-tile": return CGPoint(x: 50, y: 50)
        default: return nil
        }
    }
    static func path(_ name: String) -> Path? {
        var p = Path()
        switch name {
        case "comet":
            p.move(to: CGPoint(x: 8, y: 10))
            p.addLine(to: CGPoint(x: 61, y: 22))
            p.addCurve(to: CGPoint(x: 89, y: 69), control1: CGPoint(x: 85, y: 26), control2: CGPoint(x: 97, y: 47))
            p.addCurve(to: CGPoint(x: 34, y: 80), control1: CGPoint(x: 81, y: 93), control2: CGPoint(x: 51, y: 98))
            p.addLine(to: CGPoint(x: 10, y: 52))
            p.addLine(to: CGPoint(x: 32, y: 54))
            p.addLine(to: CGPoint(x: 8, y: 10))
            p.closeSubpath()
        case "sprout":
            p.move(to: CGPoint(x: 44, y: 91))
            p.addLine(to: CGPoint(x: 44, y: 57))
            p.addCurve(to: CGPoint(x: 10, y: 16), control1: CGPoint(x: 15, y: 59), control2: CGPoint(x: 7, y: 37))
            p.addCurve(to: CGPoint(x: 50, y: 43), control1: CGPoint(x: 33, y: 15), control2: CGPoint(x: 48, y: 25))
            p.addCurve(to: CGPoint(x: 92, y: 12), control1: CGPoint(x: 54, y: 21), control2: CGPoint(x: 72, y: 10))
            p.addCurve(to: CGPoint(x: 56, y: 57), control1: CGPoint(x: 93, y: 37), control2: CGPoint(x: 80, y: 55))
            p.addLine(to: CGPoint(x: 56, y: 91))
            p.closeSubpath()
        case "ribbon":
            p.move(to: CGPoint(x: 12, y: 12))
            p.addLine(to: CGPoint(x: 67, y: 12))
            p.addLine(to: CGPoint(x: 89, y: 34))
            p.addLine(to: CGPoint(x: 65, y: 58))
            p.addLine(to: CGPoint(x: 88, y: 88))
            p.addLine(to: CGPoint(x: 33, y: 88))
            p.addLine(to: CGPoint(x: 11, y: 66))
            p.addLine(to: CGPoint(x: 35, y: 42))
            p.closeSubpath()
        case "orbit":
            p.move(to: CGPoint(x: 23, y: 38))
            p.addCurve(to: CGPoint(x: 79, y: 34), control1: CGPoint(x: 24, y: 4), control2: CGPoint(x: 71, y: 3))
            p.addCurve(to: CGPoint(x: 82, y: 58), control1: CGPoint(x: 99, y: 25), control2: CGPoint(x: 99, y: 41))
            p.addCurve(to: CGPoint(x: 22, y: 66), control1: CGPoint(x: 77, y: 93), control2: CGPoint(x: 31, y: 96))
            p.addCurve(to: CGPoint(x: 23, y: 38), control1: CGPoint(x: 0, y: 77), control2: CGPoint(x: 1, y: 59))
            p.closeSubpath()
        case "lantern":
            p.move(to: CGPoint(x: 35, y: 8))
            p.addLine(to: CGPoint(x: 65, y: 8))
            p.addLine(to: CGPoint(x: 65, y: 20))
            p.addLine(to: CGPoint(x: 82, y: 32))
            p.addLine(to: CGPoint(x: 75, y: 77))
            p.addLine(to: CGPoint(x: 59, y: 86))
            p.addLine(to: CGPoint(x: 59, y: 94))
            p.addLine(to: CGPoint(x: 41, y: 94))
            p.addLine(to: CGPoint(x: 41, y: 86))
            p.addLine(to: CGPoint(x: 25, y: 77))
            p.addLine(to: CGPoint(x: 18, y: 32))
            p.addLine(to: CGPoint(x: 35, y: 20))
            p.closeSubpath()
        case "notched-tile":
            p.move(to: CGPoint(x: 16, y: 10))
            p.addLine(to: CGPoint(x: 84, y: 10))
            p.addQuadCurve(to: CGPoint(x: 90, y: 16), control: CGPoint(x: 90, y: 10))
            p.addLine(to: CGPoint(x: 90, y: 38))
            p.addLine(to: CGPoint(x: 76, y: 38))
            p.addLine(to: CGPoint(x: 76, y: 62))
            p.addLine(to: CGPoint(x: 90, y: 62))
            p.addLine(to: CGPoint(x: 90, y: 84))
            p.addQuadCurve(to: CGPoint(x: 84, y: 90), control: CGPoint(x: 90, y: 90))
            p.addLine(to: CGPoint(x: 16, y: 90))
            p.addQuadCurve(to: CGPoint(x: 10, y: 84), control: CGPoint(x: 10, y: 90))
            p.addLine(to: CGPoint(x: 10, y: 62))
            p.addLine(to: CGPoint(x: 24, y: 62))
            p.addLine(to: CGPoint(x: 24, y: 38))
            p.addLine(to: CGPoint(x: 10, y: 38))
            p.addLine(to: CGPoint(x: 10, y: 16))
            p.addQuadCurve(to: CGPoint(x: 16, y: 10), control: CGPoint(x: 10, y: 10))
            p.closeSubpath()
        default: return nil
        }
        return p
    }
}

