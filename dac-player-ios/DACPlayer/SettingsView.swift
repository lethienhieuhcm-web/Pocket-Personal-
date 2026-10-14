import SwiftUI

/// 4.7: Tab Cài đặt — tài khoản, phiên đăng nhập, đăng xuất.
/// (Tab Tìm kiếm thêm ở 4.8 theo roadmap.)
struct SettingsView: View {
    @EnvironmentObject var auth: AuthManager
    @EnvironmentObject var driveAuth: DriveAuthManager

    var body: some View {
        NavigationStack {
            List {
                Section("Tài khoản") {
                    if let email = auth.email {
                        Text(email)
                    }
                    NavigationLink("Phiên đăng nhập") {
                        SessionsView()
                    }
                }

                Section("Google Drive") {
                    HStack {
                        Text("Trạng thái")
                        Spacer()
                        Text(driveAuth.isConnected ? "Đã kết nối" : "Chưa kết nối")
                            .foregroundStyle(.secondary)
                    }
                    if !driveAuth.isConnected {
                        Button("Kết nối Google Drive") {
                            Task { await driveAuth.signIn() }
                        }
                    }
                }

                Section {
                    Button("Đăng xuất", role: .destructive) {
                        Task { await auth.logout() }
                    }
                }
            }
            .navigationTitle("Cài đặt")
        }
    }
}
