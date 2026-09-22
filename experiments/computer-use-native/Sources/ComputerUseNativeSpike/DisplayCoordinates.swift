import Foundation

public struct DesktopPoint: Equatable, Sendable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

public struct DesktopRect: Equatable, Sendable {
    public let origin: DesktopPoint
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        origin = DesktopPoint(x: x, y: y)
        self.width = width
        self.height = height
    }

    public var maxX: Double { origin.x + width }
    public var maxY: Double { origin.y + height }

    public func contains(_ point: DesktopPoint) -> Bool {
        point.x >= origin.x && point.x < maxX && point.y >= origin.y && point.y < maxY
    }
}

public enum CoordinateError: Error, Equatable {
    case invalidFrame
    case mismatchedFrameSize
    case invalidScale
    case pointOutsideDisplay
}

public struct DisplayCoordinateMap: Equatable, Sendable {
    public let displayID: UInt32
    public let appKitFrame: DesktopRect
    public let quartzFrame: DesktopRect
    public let backingScale: Double

    public init(
        displayID: UInt32,
        appKitFrame: DesktopRect,
        quartzFrame: DesktopRect,
        backingScale: Double
    ) throws {
        guard appKitFrame.width > 0, appKitFrame.height > 0,
              quartzFrame.width > 0, quartzFrame.height > 0 else {
            throw CoordinateError.invalidFrame
        }
        guard abs(appKitFrame.width - quartzFrame.width) < 0.000_001,
              abs(appKitFrame.height - quartzFrame.height) < 0.000_001 else {
            throw CoordinateError.mismatchedFrameSize
        }
        guard backingScale > 0 else {
            throw CoordinateError.invalidScale
        }
        self.displayID = displayID
        self.appKitFrame = appKitFrame
        self.quartzFrame = quartzFrame
        self.backingScale = backingScale
    }

    public func toQuartz(_ appKitPoint: DesktopPoint) throws -> DesktopPoint {
        guard appKitFrame.contains(appKitPoint) else {
            throw CoordinateError.pointOutsideDisplay
        }
        return DesktopPoint(
            x: quartzFrame.origin.x + appKitPoint.x - appKitFrame.origin.x,
            y: quartzFrame.maxY - appKitPoint.y + appKitFrame.origin.y
        )
    }

    public func toAppKit(_ quartzPoint: DesktopPoint) throws -> DesktopPoint {
        guard quartzFrame.contains(quartzPoint) else {
            throw CoordinateError.pointOutsideDisplay
        }
        return DesktopPoint(
            x: appKitFrame.origin.x + quartzPoint.x - quartzFrame.origin.x,
            y: appKitFrame.origin.y + quartzFrame.maxY - quartzPoint.y
        )
    }

    public func toLocalPixels(_ appKitPoint: DesktopPoint) throws -> DesktopPoint {
        let quartzPoint = try toQuartz(appKitPoint)
        return DesktopPoint(
            x: (quartzPoint.x - quartzFrame.origin.x) * backingScale,
            y: (quartzPoint.y - quartzFrame.origin.y) * backingScale
        )
    }
}
