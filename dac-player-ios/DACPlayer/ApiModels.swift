import Foundation

/// Model JSON cho Worker API — dịch từ ApiModels.kt (Android).
/// Field nào app không cần thì không khai báo (Codable bỏ qua field lạ).

// --- Auth (POST /api/auth/login, /api/auth/register) ---

struct Fingerprint: Codable {
    let screen: String
    let tz: String
    let lang: String
}

struct LoginRequest: Codable {
    let email: String
    let password: String
    let fp: Fingerprint
}

struct RegisterRequest: Codable {
    let email: String
    let password: String
}

struct RegisterResponse: Codable {
    let ok: Bool
    let email: String
    let verified: Bool
    let needsVerification: Bool
    let emailSent: Bool
}

struct AuthResponse: Codable {
    let token: String
    let email: String
}

struct ErrorResponse: Codable {
    let error: String
    let details: String?
    let needsVerification: Bool?
}

struct EmailRequest: Codable {
    let email: String
}

// --- Drive (GET /api/dac/music, /api/dac/stream, POST /api/dac/resolve, /api/dac/copy) ---

struct DriveFile: Codable {
    let id: String
    let name: String
    let size: Int64
    let mimeType: String
}

struct MusicListResponse: Codable {
    let files: [DriveFile]
}

struct ResolveRequest: Codable {
    let link: String
}

struct ResolveResponse: Codable {
    let id: String
    let name: String
    let isFolder: Bool
    let files: [DriveFile]

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        isFolder = try c.decodeIfPresent(Bool.self, forKey: .isFolder) ?? false
        files = try c.decodeIfPresent([DriveFile].self, forKey: .files) ?? []
    }
}

struct CopyRequest: Codable {
    let sourceId: String
    let destName: String
}

struct CopyResponse: Codable {
    let copiedId: String
    let name: String
    let size: Int64
    let mimeType: String
    let method: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        copiedId = try c.decodeIfPresent(String.self, forKey: .copiedId) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        size = try c.decodeIfPresent(Int64.self, forKey: .size) ?? 0
        mimeType = try c.decodeIfPresent(String.self, forKey: .mimeType) ?? ""
        method = try c.decodeIfPresent(String.self, forKey: .method) ?? ""
    }
}

/// Lỗi riêng khi email chưa verify — UI hiện nút "Gửi lại email xác nhận".
struct EmailNotVerifiedError: Error {
    let message = "Email chưa được xác nhận. Vui lòng kiểm tra hộp thư và bấm link xác nhận."
}
