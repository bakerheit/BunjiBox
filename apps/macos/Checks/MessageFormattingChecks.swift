import Foundation

@main
struct MessageFormattingChecks {
    static func main() {
        checkBlocks()
        checkCode()
        checkInlineAndLinks()
        checkColors()
        print("Native message formatting checks passed: blocks, nesting, tables, code, streaming prefixes, safe links, and contrast.")
    }

    private static func checkBlocks() {
        let source = "# Plan\n\nFirst paragraph.\nStill here.\n\nSecond paragraph.\n\n## Steps ##\n\n1. First\n2. Second\n   - Nested\n     - Deeper\n3. Last\n\n> A quote\n>\n> - quoted list\n\n---\n\nDone."
        precondition(MessageMarkdown.parse(source) == [
            .heading(1, "Plan"), .paragraph("First paragraph.\nStill here."), .paragraph("Second paragraph."),
            .heading(2, "Steps"), .listItem("1.", [.paragraph("First")]),
            .listItem("2.", [.paragraph("Second"), .listItem("•", [.paragraph("Nested"), .listItem("•", [.paragraph("Deeper")])])]),
            .listItem("3.", [.paragraph("Last")]), .quote([.paragraph("A quote"), .listItem("•", [.paragraph("quoted list")])]),
            .rule, .paragraph("Done.")
        ], "Paragraph boundaries and nested list hierarchy must survive rendering")
        precondition(source.contains("## Steps ##"), "Parsing must not mutate the source")
        precondition(MessageMarkdown.parse("7) Seven\n8) Eight\n\n+ Plus\n* Star") == [
            .listItem("7)", [.paragraph("Seven")]), .listItem("8)", [.paragraph("Eight")]),
            .listItem("•", [.paragraph("Plus")]), .listItem("•", [.paragraph("Star")])
        ])
        precondition(MessageMarkdown.parse("- Parent\n  wrapped line\n\n  Second paragraph\n\n  ```swift\n  let n = 1\n  ```\n- Next") == [
            .listItem("•", [.paragraph("Parent\nwrapped line"), .paragraph("Second paragraph"), .code(language: "swift", text: "let n = 1\n")]),
            .listItem("•", [.paragraph("Next")])
        ])
        precondition(MessageMarkdown.parse("- wrapped\ncontinuation\n- next") == [
            .listItem("•", [.paragraph("wrapped\ncontinuation")]), .listItem("•", [.paragraph("next")])
        ])
        precondition(MessageMarkdown.parse("> outer\n> > inner") == [.quote([.paragraph("outer"), .quote([.paragraph("inner")])])])
        precondition(MessageMarkdown.parse("| Name | Value |\n| :--- | ---: |\n| A | `x|y` |\n| B\\|C | **bold** |\n| partial |\n| extra | 2 | retained |") == [
            .table(headers: ["Name", "Value"], rows: [["A", "`x|y`"], ["B\\|C", "**bold**"], ["partial"], ["extra", "2", "retained"]])
        ])
        precondition(MessageMarkdown.parse("A | B\n--- | ---\nx | y") == [.table(headers: ["A", "B"], rows: [["x", "y"]])])
        precondition(MessageMarkdown.parse("A | B\nnot a separator") == [.paragraph("A | B\nnot a separator")])
        precondition(MessageMarkdown.parse("#hashtag\n2026.09\n---oops") == [.paragraph("#hashtag\n2026.09\n---oops")])
        precondition(MessageMarkdown.parse("\n \n\t") == [])
        precondition(MessageMarkdown.parse("one\r\n\r\ntwo") == [.paragraph("one"), .paragraph("two")])

        // Every prefix can occur while a response is being received. Incomplete
        // constructs must stay parseable, including an open fence or half a table.
        for end in source.indices { _ = MessageMarkdown.parse(String(source[..<end])) }
        let deeplyNested = String(repeating: "> ", count: 100) + "still present"
        precondition(String(describing: MessageMarkdown.parse(deeplyNested)).contains("still present"))
    }

    private static func checkCode() {
        let body = "  let x = 1\n\n\tprint(x)\n"
        precondition(MessageMarkdown.parse("```swift\n" + body + "```\n\nAfter") == [
            .code(language: "swift", text: body), .paragraph("After")
        ], "Copy must receive the full code body, including whitespace")
        precondition(MessageMarkdown.parse("````md\n```\n# Not a heading\n```\n````") == [
            .code(language: "md", text: "```\n# Not a heading\n```\n")
        ])
        precondition(MessageMarkdown.parse("~~~\na\n~~~") == [.code(language: "", text: "a\n")])
        precondition(MessageMarkdown.parse("```\n```") == [.code(language: "", text: "")])
        precondition(MessageMarkdown.parse("```swift\n  partial") == [.code(language: "swift", text: "  partial")])
        precondition(MessageMarkdown.parse("```swift\n  partial\n") == [.code(language: "swift", text: "  partial\n")])
        precondition(MessageMarkdown.parse("  ```\n    indented\n  ```") == [.code(language: "", text: "  indented\n")])
        let longLine = String(repeating: "let_value ", count: 500)
        precondition(MessageMarkdown.parse("```\n\(longLine)\n```") == [.code(language: "", text: longLine + "\n")])
        let streamedCode = "```swift\nlet text = \"😀\"\n\n```"
        for end in streamedCode.indices { _ = MessageMarkdown.parse(String(streamedCode[..<end])) }
    }

    private static func checkInlineAndLinks() {
        let inline = MessageMarkdown.inline("**bold** and *emphasis* and `code`\nsecond line")
        precondition(String(inline.characters) == "bold and emphasis and code\nsecond line")
        precondition(inline.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        precondition(inline.runs.contains { $0.inlinePresentationIntent?.contains(.emphasized) == true })
        precondition(inline.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
        for address in ["https://example.com/docs?q=1#part", "http://localhost:4318", "mailto:hello@example.com"] {
            precondition(MessageMarkdown.isSafeURL(URL(string: address)!))
            let text = MessageMarkdown.inline("[open](\(address))")
            precondition(text.runs.contains { $0.link != nil })
        }
        for address in ["file:///tmp/private", "javascript:alert", "data:text/html,bad", "x-apple.systempreferences:privacy", "relative/path", "https:", "https://user:pass@example.com"] {
            precondition(!MessageMarkdown.isSafeURL(URL(string: address)!))
            let text = MessageMarkdown.inline("[label](\(address))")
            precondition(!text.runs.contains { $0.link != nil }, "Unsafe links must not be clickable")
            precondition(String(text.characters).contains("label"), "Blocked links must retain their text")
        }
        precondition(String(MessageMarkdown.inline("unfinished **bold").characters).contains("unfinished"))
    }

    private static func checkColors() {
        // All avatar presets, extreme custom colors, white and invalid fallbacks.
        let colors = ["#ffffff", "#895e34", "#ee1734", "#ff6a00", "#ff9c00", "#00a56a", "#00ad9c", "#087ee7", "#8247e5", "#e82692", "#777777", "#000000", "#ffff00", "#00ffff", "#ff00ff", "invalid"]
        var lowestContrast = Double.infinity
        for dark in [false, true] {
            for user in [false, true] {
                for hex in colors {
                    let palette = MessageBubbleColors(avatarHex: hex, isUser: user, isDark: dark)
                    for foreground in [palette.foreground, palette.secondary] {
                        let contrast = foreground.contrast(with: palette.background)
                        lowestContrast = min(lowestContrast, contrast)
                        precondition(contrast >= 4.5, "Text contrast must meet 4.5:1: \(hex), dark=\(dark), user=\(user): \(contrast)")
                    }
                }
                let white = MessageBubbleColors(avatarHex: "#ffffff", isUser: user, isDark: dark).background
                precondition(white.red == white.green && white.green == white.blue, "White avatars use a neutral bubble")
            }
            let user = MessageBubbleColors(avatarHex: "#087ee7", isUser: true, isDark: dark)
            let assistant = MessageBubbleColors(avatarHex: "#087ee7", isUser: false, isDark: dark)
            precondition(user.background != assistant.background)
            precondition(user.background.red == user.background.green && user.background.green == user.background.blue, "Human bubbles must stay neutral")
            precondition(user.background == MessageBubbleColors(avatarHex: "#ee1734", isUser: true, isDark: dark).background, "Changing agents must not recolor human messages")
            precondition(assistant.background.blue > assistant.background.red)
        }
        print(String(format: "Minimum tested body/metadata contrast: %.2f:1", lowestContrast))
    }
}
