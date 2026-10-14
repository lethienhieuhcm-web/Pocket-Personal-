import Foundation

/// Quản lý Drive token trên iOS.
///
/// Token lấy từ Google Sign-In SDK (bước 3.2 plan) — cần iOS OAuth client ID
/// tạo trong Google Cloud Console (việc một lần, phía anh). Class này đã có
/// sẵn storage (Keychain) + interface; khi có client ID chỉ cần gắn SDK vào
/// `requestToken()` rồi gọi `setToken(_:)`.
@MainActor
class DriveAuthManager: ObservableObject {
    @Published private(set) var isConnected: Bool = false

    init() {
        isConnected = token() != nil
    }

    func token() -> String? {
        KeychainHelper.load(forKey: "drive_token")?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func setToken(_ value: String) {
        KeychainHelper.save(value, forKey: "drive_token")
        isConnected = true
    }

    func clear() {
        KeychainHelper.delete(forKey: "drive_token")
        isConnected = false
    }
}
