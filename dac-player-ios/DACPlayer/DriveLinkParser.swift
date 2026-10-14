import Foundation

/// Parse Google Drive share link → file/folder ID — dịch từ DriveLinkParser.kt.
///
/// Validate nhanh ở client trước khi gọi Worker /api/dac/resolve
/// (Worker parse lại server-side — đây chỉ là check sơ bộ).
enum DriveLinkParser {
    private static let pathPattern = try! NSRegularExpression(
        pattern: "/(?:file/d|folders|d)/([a-zA-Z0-9_-]+)")
    private static let queryPattern = try! NSRegularExpression(
        pattern: "[?&]id=([a-zA-Z0-9_-]+)")
    private static let bareIdPattern = try! NSRegularExpression(
        pattern: "^[a-zA-Z0-9_-]{10,}$")

    /// Parse link → ID, hoặc nil nếu không nhận diện được.
    static func parse(_ link: String?) -> String? {
        guard let t = link?.trimmingCharacters(in: .whitespacesAndNewlines),
              !t.isEmpty else { return nil }
        let range = NSRange(t.startIndex..., in: t)
        if let m = pathPattern.firstMatch(in: t, range: range),
           let r = Range(m.range(at: 1), in: t) {
            return String(t[r])
        }
        if let m = queryPattern.firstMatch(in: t, range: range),
           let r = Range(m.range(at: 1), in: t) {
            return String(t[r])
        }
        if bareIdPattern.firstMatch(in: t, range: range) != nil {
            return t
        }
        return nil
    }

    /// Kiểm tra nhanh link có vẻ là link Drive hợp lệ không.
    static func isValid(_ link: String?) -> Bool {
        parse(link) != nil
    }
}
