import SwiftUI

struct MessageMarkdownView: View {
    private let blocks: [MessageBlock]

    init(_ source: String) { blocks = MessageMarkdown.parse(source) }

    var body: some View {
        MessageBlockStack(blocks: blocks)
            .textSelection(.enabled)
            .environment(\.openURL, OpenURLAction { url in
                MessageMarkdown.isSafeURL(url) ? .systemAction : .discarded
            })
    }
}

private struct MessageBlockStack: View {
    let blocks: [MessageBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(blocks.indices, id: \.self) { index in
                MessageBlockView(block: blocks[index])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MessageInlineText: View {
    let source: String

    private var attributed: AttributedString {
        var result = MessageMarkdown.inline(source)
        for run in result.runs {
            if run.inlinePresentationIntent?.contains(.code) == true {
                result[run.range].font = .system(.body, design: .monospaced)
            }
            // Underlines identify links without depending on avatar hue or accent contrast.
            if run.link != nil { result[run.range].underlineStyle = .single }
        }
        return result
    }

    var body: some View {
        Text(attributed)
            .lineSpacing(4)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct MessageBlockView: View {
    let block: MessageBlock

    // Type erasure breaks the recursive list/quote view type, not the data model.
    var body: AnyView {
        switch block {
        case .paragraph(let text):
            return AnyView(MessageInlineText(source: text))
        case .heading(let level, let text):
            return AnyView(MessageInlineText(source: text)
                .font(level == 1 ? .title2 : level == 2 ? .title3 : .headline)
                .fontWeight(.semibold)
                .padding(.top, 4)
                .accessibilityAddTraits(.isHeader))
        case .listItem(let marker, let children):
            return AnyView(HStack(alignment: .top, spacing: 8) {
                Text(verbatim: marker).monospacedDigit()
                    .frame(minWidth: 20, alignment: .trailing)
                MessageBlockStack(blocks: children)
            })
        case .code(let language, let text):
            return AnyView(MessageCodeBlock(language: language, text: text))
        case .quote(let children):
            return AnyView(HStack(alignment: .top, spacing: 12) {
                MessageBlockStack(blocks: children)
            }
            .padding(.leading, 14)
            .padding(.vertical, 6)
            .overlay(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2).fill(.primary.opacity(0.3)).frame(width: 3)
            })
        case .rule:
            return AnyView(Rectangle().fill(.primary.opacity(0.2)).frame(height: 1).padding(.vertical, 4))
        case .table(let headers, let rows):
            return AnyView(MessageTable(headers: headers, rows: rows))
        }
    }
}

private struct MessageCodeBlock: View {
    let language: String
    let text: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(verbatim: language.isEmpty ? "Code" : language).font(.caption).lineLimit(1)
                Spacer()
                Button {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                    copied = true
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                }
                .font(.caption).buttonStyle(.borderless)
                .help("Copy code")
                .accessibilityLabel(copied ? "Code copied" : "Copy code")
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            ScrollView(.horizontal) {
                Text(verbatim: text)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(12)
            }
        }
        .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.primary.opacity(0.12), lineWidth: 1))
        .onChange(of: text) { _, _ in copied = false }
    }
}

private struct MessageTable: View {
    let headers: [String]
    let rows: [[String]]

    private var columnCount: Int { max(headers.count, rows.map(\.count).max() ?? 0) }

    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(0..<columnCount, id: \.self) { column in
                        cell(column < headers.count ? headers[column] : "")
                            .fontWeight(.semibold)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
                .background(.primary.opacity(0.06))
                ForEach(rows.indices, id: \.self) { row in
                    GridRow {
                        ForEach(0..<columnCount, id: \.self) { column in
                            cell(column < rows[row].count ? rows[row][column] : "")
                        }
                    }
                }
            }
        }
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(.primary.opacity(0.15), lineWidth: 1))
    }

    private func cell(_ text: String) -> some View {
        MessageInlineText(source: text)
            .frame(width: 180, alignment: .leading)
            .padding(10)
            .frame(maxHeight: .infinity, alignment: .topLeading)
            .overlay(alignment: .bottom) { Rectangle().fill(.primary.opacity(0.12)).frame(height: 1) }
    }
}

extension MessageRGB {
    var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: 1) }
}

struct MessageBubble: ViewModifier {
    let colors: MessageBubbleColors

    func body(content: Content) -> some View {
        content
            .foregroundStyle(colors.foreground.color)
            .tint(colors.foreground.color)
            .padding(.horizontal, 16).padding(.vertical, 12)
            .background(colors.background.color, in: RoundedRectangle(cornerRadius: 16))
    }
}
