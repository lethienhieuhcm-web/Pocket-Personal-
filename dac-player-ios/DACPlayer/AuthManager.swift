import Foundation
import UIKit

/// Quản lý đăng nhập Pocket Personal — dịch từ AuthManager.kt (Android).
///
/// API: POST /api/auth/login {email, password, fp} → {token, email, ...}
/// Token lưu Keychain (keys "session_token", "authEmail").
@MainActor
class AuthManager: ObservableObject {
    static let baseURL = "https://lethanhdong.one"

    @Published private(set) var isLoggedIn: Bool = false
    @Published private(set) var email: String? = nil

    init() {
        let t = token()
        isLoggedIn = t != nil
        email = KeychainHelper.load(forKey: "authEmail")
    }

    func token() -> String? {
        KeychainHelper.load(forKey: "session_token")?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Fingerprint thiết bị gửi kèm login — Worker dùng làm lock key
    /// per-(email+fingerprint). Cùng format Android gửi.
    private func fingerprint() -> Fingerprint {
        let bounds = UIScreen.main.bounds
        return Fingerprint(
            screen: "\(Int(bounds.width))x\(Int(bounds.height))",
            tz: TimeZone.current.identifier,
            lang: Locale.current.language.languageCode?.identifier ?? "en"
        )
    }

    private func post(_ path: String, body: Encodable, bearer: String? = nil) async throws -> (Data, Int) {
        let url = URL(string: Self.baseURL + path)!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let bearer = bearer {
            req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return (data, code)
    }

    private func errorMessage(_ data: Data, fallback: String) -> String {
        if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data),
           !err.error.isEmpty {
            return err.error
        }
        return fallback
    }

    /// Đăng nhập. True nếu thành công, throw nếu sai credentials / lỗi mạng.
    func login(email: String, password: String) async throws {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let body = LoginRequest(email: cleanEmail, password: password, fp: fingerprint())
        let (data, code) = try await post("/api/auth/login", body: body)
        switch code {
        case 200:
            let auth = try JSONDecoder().decode(AuthResponse.self, from: data)
            KeychainHelper.save(auth.token, forKey: "session_token")
            KeychainHelper.save(auth.email.isEmpty ? cleanEmail : auth.email, forKey: "authEmail")
            isLoggedIn = true
            self.email = auth.email.isEmpty ? cleanEmail : auth.email
        case 401:
            throw AuthError.message("Sai email hoặc mật khẩu")
        case 403:
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data),
               err.error == "email_not_verified" {
                throw EmailNotVerifiedError()
            }
            throw AuthError.message(errorMessage(data, fallback: "Lỗi đăng nhập: HTTP \(code)"))
        case 429:
            throw AuthError.message(errorMessage(data, fallback: "Quá nhiều lần đăng nhập sai. Thử lại sau 15 phút."))
        default:
            throw AuthError.message(errorMessage(data, fallback: "Lỗi đăng nhập: HTTP \(code)"))
        }
    }

    /// Đăng ký tài khoản mới. Trả về RegisterResponse (có needsVerification).
    func register(email: String, password: String) async throws -> RegisterResponse {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let (data, code) = try await post("/api/auth/register", body: RegisterRequest(email: cleanEmail, password: password))
        switch code {
        case 200:
            return try JSONDecoder().decode(RegisterResponse.self, from: data)
        case 409:
            throw AuthError.message("Email đã đăng ký, vui lòng đăng nhập")
        case 429:
            throw AuthError.message(errorMessage(data, fallback: "Đăng ký quá nhiều. Thử lại sau."))
        case 400:
            throw AuthError.message(errorMessage(data, fallback: "Thông tin đăng ký không hợp lệ"))
        default:
            throw AuthError.message(errorMessage(data, fallback: "Lỗi đăng ký: HTTP \(code)"))
        }
    }

    /// Gửi lại email xác nhận. Luôn thành công (server không tiết lộ email có tồn tại).
    func resendVerification(email: String) async -> Bool {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        do {
            let (_, code) = try await post("/api/auth/resend-verification", body: EmailRequest(email: cleanEmail))
            return code == 200
        } catch {
            return false
        }
    }

    /// Quên mật khẩu — gửi email reset link.
    func forgotPassword(email: String) async -> Bool {
        let cleanEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        do {
            let (_, code) = try await post("/api/auth/forgot-password", body: EmailRequest(email: cleanEmail))
            return code == 200
        } catch {
            return false
        }
    }

    /// Đăng xuất — POST /api/auth/logout (xoá session server) + xoá Keychain.
    /// Luôn xoá local kể cả khi gọi server lỗi.
    func logout() async {
        if let t = token() {
            do {
                _ = try await post("/api/auth/logout", body: EmptyBody(), bearer: t)
            } catch {
                // Bỏ qua lỗi server/mạng — vẫn xoá local bên dưới
            }
        }
        KeychainHelper.delete(forKey: "session_token")
        KeychainHelper.delete(forKey: "authEmail")
        isLoggedIn = false
        email = nil
    }
}

struct EmptyBody: Codable {}

enum AuthError: Error {
    case message(String)
}
