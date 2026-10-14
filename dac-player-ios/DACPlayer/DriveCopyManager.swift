import Foundation

/// Quản lý copy nhạc từ Drive share link — dịch từ DriveCopyManager.kt.
///
/// Luồng:
/// 1. App parse link sơ bộ (DriveLinkParser) → gọi Worker POST /api/dac/resolve
/// 2. Worker trả metadata + danh sách file audio (nếu là folder)
/// 3. User chọn file → app gọi Worker POST /api/dac/copy từng file
/// 4. Worker thử server-side copy (files.copy) — nhanh, không tốn băng thông
///
/// Auth: session Pocket Personal (Authorization) + X-Drive-Token.
/// Worker KHÔNG lưu token Drive.
@MainActor
class DriveCopyManager: ObservableObject {
    private let auth: AuthManager
    private let driveToken: () -> String?

    init(auth: AuthManager, driveToken: @escaping () -> String?) {
        self.auth = auth
        self.driveToken = driveToken
    }

    /// POST Worker API với auth + drive token.
    private func post(_ path: String, body: Encodable) async throws -> (Data, Int) {
        guard let token = auth.token() else {
            throw CopyError.message("Chưa đăng nhập")
        }
        let url = URL(string: AuthManager.baseURL + path)!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let dt = driveToken() {
            req.setValue(dt, forHTTPHeaderField: "X-Drive-Token")
        }
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        return (data, code)
    }

    private func serverMessage(_ data: Data) -> String? {
        if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data),
           !err.error.isEmpty {
            return err.error
        }
        return nil
    }

    /// Resolve share link → thông tin file/folder + danh sách file nhạc.
    func resolve(link: String) async throws -> ResolveResponse {
        guard DriveLinkParser.isValid(link) else {
            throw CopyError.message("Link không đúng định dạng Google Drive")
        }
        let (data, code) = try await post("/api/dac/resolve",
                                          body: ResolveRequest(link: link.trimmingCharacters(in: .whitespacesAndNewlines)))
        switch code {
        case 200:
            return try JSONDecoder().decode(ResolveResponse.self, from: data)
        case 401:
            throw CopyError.message("Hết phiên đăng nhập (401)")
        case 400:
            throw CopyError.message(serverMessage(data) ?? "Link không hợp lệ (400)")
        case 404:
            throw CopyError.message(serverMessage(data) ?? "Không tìm thấy (link sai hoặc chưa share)")
        default:
            throw CopyError.message(serverMessage(data) ?? "Lỗi: HTTP \(code)")
        }
    }

    /// Copy 1 file vào Drive của user (server-side).
    /// Throw CopyScopeError khi token không đủ quyền — UI hiện hướng dẫn riêng.
    func copy(sourceId: String, destName: String = "") async throws -> CopyResponse {
        let (data, code) = try await post("/api/dac/copy",
                                          body: CopyRequest(sourceId: sourceId, destName: destName))
        switch code {
        case 200:
            return try JSONDecoder().decode(CopyResponse.self, from: data)
        case 401:
            throw CopyError.message("Hết phiên đăng nhập (401)")
        case 400, 404, 429, 502:
            throw CopyError.message(serverMessage(data) ?? "Copy lỗi: HTTP \(code)")
        case 403:
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data),
               err.error == "insufficient_scope" {
                let details = err.details ?? ""
                throw CopyScopeError(message: details.isEmpty
                    ? "Không đủ quyền copy file này. Ngắt kết nối Drive rồi kết nối lại và cấp quyền đầy đủ khi hệ thống hỏi."
                    : details)
            }
            throw CopyError.message(serverMessage(data) ?? "Bị từ chối (403)")
        default:
            throw CopyError.message(serverMessage(data) ?? "Copy lỗi: HTTP \(code)")
        }
    }
}

enum CopyError: Error {
    case message(String)
}

/// Lỗi scope khi copy — UI bắt riêng để hiện hướng dẫn cấp quyền.
struct CopyScopeError: Error {
    let message: String
}
