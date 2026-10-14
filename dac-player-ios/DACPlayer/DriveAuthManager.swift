import Foundation
import GoogleSignIn
import UIKit

/// Quản lý Drive token trên iOS qua Google Sign-In SDK.
///
/// - Client ID: iOS OAuth client (Google Cloud Console, tạo 2026-10-14).
/// - Scope: drive.readonly (đồng bộ Android — đã Chốt).
/// - SDK tự lưu session trong Keychain; mở app gọi restore để nối lại.
/// - Token gửi lên Worker qua header X-Drive-Token (MusicApiClient).
@MainActor
class DriveAuthManager: ObservableObject {
    @Published private(set) var isConnected: Bool = false
    @Published var errorMessage: String? = nil

    static let clientID = "130582344226-kqp2c1fvctll70aod0ehg0v7qo469785.apps.googleusercontent.com"
    static let driveScope = "https://www.googleapis.com/auth/drive.readonly"

    init() {
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: Self.clientID)
        Task { await restore() }
    }

    /// Nối lại phiên cũ (nếu có) khi mở app.
    func restore() async {
        do {
            let user = try await GIDSignIn.sharedInstance.restorePreviousSignIn()
            isConnected = hasDriveScope(user)
            errorMessage = nil
        } catch {
            isConnected = false
        }
    }

    /// Access token hiện tại (đồng bộ — MusicApiClient/DriveCopyManager dùng).
    /// Token hết hạn → Worker trả 401 "Drive token invalid" → UI gọi clear()
    /// để user kết nối lại (đồng bộ hành vi Android/iOS).
    func token() -> String? {
        guard let user = GIDSignIn.sharedInstance.currentUser,
              hasDriveScope(user) else { return nil }
        return user.accessToken.tokenString
    }

    /// Đăng nhập Google + xin quyền đọc Drive. Gọi từ nút "Kết nối".
    func signIn() async {
        errorMessage = nil
        guard let vc = Self.presentingViewController() else {
            errorMessage = "Không mở được màn hình đăng nhập."
            return
        }
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(
                withPresenting: vc,
                hint: nil,
                additionalScopes: [Self.driveScope]
            )
            isConnected = hasDriveScope(result.user)
            if !isConnected {
                errorMessage = "Chưa cấp quyền đọc Google Drive."
            }
        } catch {
            // User bấm huỷ → im lặng, không báo lỗi.
            let ns = error as NSError
            if ns.domain != "com.google.GIDSignIn" || ns.code != -5 {
                errorMessage = "Đăng nhập thất bại. Thử lại."
            }
            isConnected = false
        }
    }

    /// Đăng xuất Drive (giữ nguyên session Pocket Personal).
    func signOut() {
        GIDSignIn.sharedInstance.signOut()
        isConnected = false
        errorMessage = nil
    }

    /// Alias cho signOut — các màn hình gọi khi Worker báo "Drive token invalid".
    func clear() { signOut() }

    private func hasDriveScope(_ user: GIDGoogleUser) -> Bool {
        user.grantedScopes?.contains(Self.driveScope) ?? false
    }

    private static func presentingViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let window = scene.windows.first(where: { $0.isKeyWindow }),
              var top = window.rootViewController else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }
}
