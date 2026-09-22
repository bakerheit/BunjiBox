import AppKit
import ImageIO

enum AvatarImageError: LocalizedError {
    case tooLarge, unreadable
    var errorDescription: String? {
        switch self {
        case .tooLarge: "Choose an image up to 5 MB."
        case .unreadable: "This picture could not be opened. Try another PNG, JPG, or WebP."
        }
    }
}

enum AvatarImageData {
    static func load(_ url: URL) throws -> String {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size <= 5 * 1024 * 1024 else { throw AvatarImageError.tooLarge }
        return try normalize(Data(contentsOf: url))
    }

    // Store the same portable data URL used by the web app, never a local file path.
    static func normalize(_ data: Data) throws -> String {
        guard data.count <= 5 * 1024 * 1024 else { throw AvatarImageError.tooLarge }
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 1024,
              ] as CFDictionary),
              let context = CGContext(data: nil, width: 256, height: 256, bitsPerComponent: 8,
                                      bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw AvatarImageError.unreadable }
        let edge = min(image.width, image.height)
        guard let cropped = image.cropping(to: CGRect(x: (image.width - edge) / 2,
                                                      y: (image.height - edge) / 2,
                                                      width: edge, height: edge)) else { throw AvatarImageError.unreadable }
        context.interpolationQuality = .high
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: 256, height: 256))
        guard let square = context.makeImage() else { throw AvatarImageError.unreadable }
        let bitmap = NSBitmapImageRep(cgImage: square)
        if let png = bitmap.representation(using: .png, properties: [:]) {
            let value = "data:image/png;base64," + png.base64EncodedString()
            if value.count <= 350000 { return value }
        }
        guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) else { throw AvatarImageError.unreadable }
        let value = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        guard value.count <= 350000 else { throw AvatarImageError.tooLarge }
        return value
    }
}
