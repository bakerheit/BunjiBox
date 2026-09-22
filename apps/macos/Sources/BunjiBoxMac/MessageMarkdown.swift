import Foundation

// A presentation-only parser. The request's prompt/text remain the source of truth.
// Unsupported syntax stays readable as text; no HTML or remote images are rendered.
indirect enum MessageBlock: Equatable {
    case paragraph(String)
    case heading(Int, String)
    case listItem(String, [MessageBlock])
    case code(language: String, text: String)
    case quote([MessageBlock])
    case rule
    case table(headers: [String], rows: [[String]])
}

enum MessageMarkdown {
    static func parse(_ source: String) -> [MessageBlock] {
        parse(source.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n"), depth: 0)
    }

    private struct ListMarker {
        let label: String
        let indentation: Int
        let contentIndentation: Int
        let text: String
    }

    private static func capture(_ pattern: String, _ text: String) -> [String]? {
        guard let match = text.range(of: pattern, options: .regularExpression) else { return nil }
        let matched = String(text[match])
        return [matched, String(text[match.upperBound...])]
    }

    private static func indentation(_ line: String) -> Int {
        line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
    }

    private static func unindent(_ line: String, by amount: Int) -> String {
        var columns = 0
        var index = line.startIndex
        while index < line.endIndex, columns < amount, line[index] == " " || line[index] == "\t" {
            columns += line[index] == "\t" ? 4 : 1
            index = line.index(after: index)
        }
        return String(repeating: " ", count: max(0, columns - amount)) + line[index...]
    }

    private static func listMarker(_ line: String) -> ListMarker? {
        let indent = indentation(line)
        let trimmed = line.drop(while: { $0 == " " || $0 == "\t" })
        guard let parts = capture(#"^(?:[-+*]|[0-9]{1,9}[.)])(?:[ \t]+|$)"#, String(trimmed)) else { return nil }
        let marker = parts[0].trimmingCharacters(in: .whitespaces)
        return ListMarker(label: ["-", "+", "*"].contains(marker) ? "•" : marker,
                          indentation: indent,
                          contentIndentation: indent + max(marker.count + 1, indentationWidth(parts[0])),
                          text: parts[1])
    }

    private static func indentationWidth(_ value: String) -> Int {
        value.reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
    }

    private static func fence(_ line: String) -> (marker: Character, count: Int, language: String)? {
        guard let parts = capture(#"^ {0,3}(?:`{3,}|~{3,})"#, line) else { return nil }
        let marker = parts[0].trimmingCharacters(in: .whitespaces)
        let language = parts[1].trimmingCharacters(in: .whitespaces)
        guard marker.first != "`" || !language.contains("`") else { return nil }
        return (marker.first!, marker.count, language)
    }

    private static func heading(_ line: String) -> (Int, String)? {
        guard let parts = capture(#"^ {0,3}#{1,6}(?:[ \t]+|$)"#, line) else { return nil }
        let title = parts[1].replacingOccurrences(of: #"[ \t]+#+[ \t]*$"#, with: "", options: .regularExpression)
        return (parts[0].filter { $0 == "#" }.count, title)
    }

    private static func isRule(_ line: String) -> Bool {
        guard indentation(line) <= 3 else { return false }
        let compact = line.filter { $0 != " " && $0 != "\t" }
        return compact.count >= 3 && ["*", "-", "_"].contains(compact.first.map(String.init) ?? "")
            && compact.allSatisfy { $0 == compact.first }
    }

    private static func quoteText(_ line: String) -> String? {
        capture(#"^ {0,3}> ?"#, line)?[1]
    }

    // Pipes escaped with a backslash or inside an inline-code span are cell content.
    private static func cells(_ line: String) -> [String]? {
        let text = line.trimmingCharacters(in: .whitespaces)
        let chars = Array(text)
        var values: [String] = []
        var current = ""
        var codeTicks = 0
        var index = 0
        var separators: [Int] = []
        while index < chars.count {
            let char = chars[index]
            if char == "\\", index + 1 < chars.count {
                current.append(char); current.append(chars[index + 1]); index += 2
                continue
            }
            if char == "`" {
                var count = 1
                while index + count < chars.count, chars[index + count] == "`" { count += 1 }
                if codeTicks == 0 { codeTicks = count } else if codeTicks == count { codeTicks = 0 }
                current += String(repeating: "`", count: count)
                index += count
                continue
            }
            if char == "|", codeTicks == 0 {
                separators.append(index); values.append(current.trimmingCharacters(in: .whitespaces)); current = ""
            } else { current.append(char) }
            index += 1
        }
        guard !separators.isEmpty else { return nil }
        values.append(current.trimmingCharacters(in: .whitespaces))
        if separators.last == chars.count - 1 { values.removeLast() }
        if separators.first == 0 { values.removeFirst() }
        return values.isEmpty ? nil : values
    }

    private static func tableHeader(_ lines: [String], at index: Int) -> [String]? {
        guard index + 1 < lines.count, let headers = cells(lines[index]), let delimiters = cells(lines[index + 1]),
              headers.count == delimiters.count,
              delimiters.allSatisfy({ $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }) else { return nil }
        return headers
    }

    private static func startsBlock(_ lines: [String], at index: Int) -> Bool {
        let line = lines[index]
        return line.trimmingCharacters(in: .whitespaces).isEmpty || fence(line) != nil || heading(line) != nil
            || isRule(line) || listMarker(line) != nil || quoteText(line) != nil || tableHeader(lines, at: index) != nil
    }

    private static func parse(_ lines: [String], depth: Int) -> [MessageBlock] {
        // Bound recursion for pasted/generated input without losing any remaining text.
        guard depth < 24 else { return [.paragraph(lines.joined(separator: "\n"))] }
        var result: [MessageBlock] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if line.trimmingCharacters(in: .whitespaces).isEmpty { index += 1; continue }
            if let opening = fence(line) {
                let indent = indentation(line)
                index += 1
                var code: [String] = []
                while index < lines.count {
                    if let closing = fence(lines[index]), closing.marker == opening.marker,
                       closing.count >= opening.count, closing.language.isEmpty { break }
                    code.append(unindent(lines[index], by: indent)); index += 1
                }
                // Keep the newline immediately before a closing fence, and an unfinished
                // streaming fence's exact trailing newline (represented by the final line).
                let closed = index < lines.count
                let text = code.joined(separator: "\n") + (closed && !code.isEmpty ? "\n" : "")
                result.append(.code(language: opening.language, text: text))
                if closed { index += 1 }
                continue
            }
            if let (level, title) = heading(line) {
                result.append(.heading(level, title)); index += 1; continue
            }
            if isRule(line) { result.append(.rule); index += 1; continue }
            if let first = quoteText(line) {
                var quoted = [first]; index += 1
                while index < lines.count, let next = quoteText(lines[index]) { quoted.append(next); index += 1 }
                result.append(.quote(parse(quoted, depth: depth + 1))); continue
            }
            if let marker = listMarker(line) {
                var content = [marker.text]; index += 1
                while index < lines.count {
                    let next = lines[index]
                    if next.trimmingCharacters(in: .whitespaces).isEmpty {
                        var afterBlank = index + 1
                        while afterBlank < lines.count, lines[afterBlank].trimmingCharacters(in: .whitespaces).isEmpty { afterBlank += 1 }
                        guard afterBlank < lines.count, indentation(lines[afterBlank]) > marker.indentation else { break }
                        content.append(""); index += 1; continue
                    }
                    if indentation(next) > marker.indentation {
                        content.append(unindent(next, by: marker.contentIndentation)); index += 1
                    } else if !startsBlock(lines, at: index), !content.last!.isEmpty {
                        // Markdown permits a wrapped paragraph without repeated indentation.
                        content.append(next); index += 1
                    } else { break }
                }
                result.append(.listItem(marker.label, parse(content, depth: depth + 1))); continue
            }
            if let headers = tableHeader(lines, at: index) {
                index += 2
                var rows: [[String]] = []
                while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty,
                      let row = cells(lines[index]) {
                    // Keep extra cells too, so malformed/streaming tables never hide text.
                    rows.append(row); index += 1
                }
                result.append(.table(headers: headers, rows: rows)); continue
            }
            var paragraph = [line]; index += 1
            while index < lines.count, !startsBlock(lines, at: index) {
                paragraph.append(lines[index]); index += 1
            }
            result.append(.paragraph(paragraph.joined(separator: "\n")))
        }
        return result
    }

    static func isSafeURL(_ url: URL) -> Bool {
        guard !url.absoluteString.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "https" || scheme == "http" { return !(url.host ?? "").isEmpty && url.user == nil && url.password == nil }
        // Foundation's Markdown-created mailto URLs can expose an empty URL.path.
        return scheme == "mailto" && !(URLComponents(string: url.absoluteString)?.path ?? "").isEmpty
    }

    static func inline(_ text: String) -> AttributedString {
        var attributed = (try? AttributedString(markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        for run in attributed.runs {
            if let url = run.link, !isSafeURL(url) { attributed[run.range].link = nil }
        }
        return attributed
    }
}
