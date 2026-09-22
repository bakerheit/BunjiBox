import Foundation
import ImageIO

@main
struct ProfileChecks {
    static func main() async throws {
        let api = BunjiAPI(baseURL: URL(string: CommandLine.arguments[1])!)
        let id = "native-profile-check"
        let picture = try AvatarImageData.load(URL(fileURLWithPath: CommandLine.arguments[2]))
        precondition(picture.count <= 350000)
        let bytes = Data(base64Encoded: String(picture.split(separator: ",")[1]))!
        let source = CGImageSourceCreateWithData(bytes as CFData, nil)!
        let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary
        precondition(properties[kCGImagePropertyPixelWidth] as? Int == 256)
        precondition(properties[kCGImagePropertyPixelHeight] as? Int == 256)
        do { _ = try AvatarImageData.normalize(Data("broken".utf8)); preconditionFailure("Invalid image accepted") }
        catch AvatarImageError.unreadable {}
        do { _ = try AvatarImageData.normalize(Data(count: 5 * 1024 * 1024 + 1)); preconditionFailure("Oversized image accepted") }
        catch AvatarImageError.tooLarge {}

        let photo = BotAvatar(shape: "circle", color: "#087ee7", image: picture)
        _ = try await api.patch(botID: id, changes: BotPatch(name: "Native profile QA", avatar: photo))
        // Read through a fresh client so local UI state cannot mask a failed save.
        let secondClient = BunjiAPI(baseURL: api.baseURL)
        let saved = try await secondClient.bots().bots.first { $0.id == id }!
        precondition(saved.name == "Native profile QA" && saved.avatar == photo)
        _ = try await api.patch(botID: id, changes: BotPatch(description: "Updated from another device"))
        let shape = BotAvatar(shape: "cloud", color: "#e82692", image: nil)
        _ = try await api.patch(botID: id, changes: BotPatch(avatar: shape))
        let reset = try await secondClient.bots().bots.first { $0.id == id }!
        precondition(reset.avatar == shape, "Switching to a shape must clear the stored picture")
        precondition(reset.description == "Updated from another device" && reset.name == saved.name)
        do {
            _ = try await api.patch(botID: id, changes: BotPatch(name: String(repeating: "x", count: 61)))
            preconditionFailure("Invalid name accepted")
        } catch BunjiAPIError.http(let status, _) { precondition(status == 400) }
        let afterFailure = try await secondClient.bots().bots.first { $0.id == id }!
        precondition(afterFailure == reset, "Rejected saves must not change persisted settings")
        print("Native profile upload, resize, persistence, image removal, partial edits, and rejection checks passed.")
    }
}
