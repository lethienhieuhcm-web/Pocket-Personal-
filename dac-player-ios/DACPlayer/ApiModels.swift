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

/// Lỗi riêng khi email chưa verify — UI hiện nút "Gửi lại email xác nhận".
struct EmailNotVerifiedError: Error {
    let message = "Email chưa được xác nhận. Vui lòng kiểm tra hộp thư và bấm link xác nhận."
}
