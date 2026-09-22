import SwiftUI

@main
struct DistinctAvatarChecks {
    static func main() throws {
        let result = DistinctAvatarShapes.names.map { name -> [String: Any] in
            let path = DistinctAvatarShapes.path(name)!
            let center = DistinctAvatarShapes.aperture(name)!
            precondition(path.contains(center), "Aperture must lie within its silhouette")
            precondition(path.contains(CGPoint(x: center.x + 13, y: center.y - 13)))
            precondition(path.contains(CGPoint(x: center.x - 12, y: center.y + 12)))
            var commands: [[Any]] = []
            path.cgPath.applyWithBlock { pointer in
                let element = pointer.pointee
                let command: String
                let count: Int
                switch element.type {
                case .moveToPoint: command = "M"; count = 1
                case .addLineToPoint: command = "L"; count = 1
                case .addQuadCurveToPoint: command = "Q"; count = 2
                case .addCurveToPoint: command = "C"; count = 3
                case .closeSubpath: command = "Z"; count = 0
                @unknown default: fatalError("Unknown path command")
                }
                var values: [Any] = [command]
                for index in 0..<count {
                    values.append(Double(element.points[index].x))
                    values.append(Double(element.points[index].y))
                }
                commands.append(values)
            }
            return ["name": name, "label": DistinctAvatarShapes.label(name),
                    "cx": Double(center.x), "cy": Double(center.y), "commands": commands]
        }
        let data = try JSONSerialization.data(withJSONObject: result)
        print(String(data: data, encoding: .utf8)!)
    }
}
