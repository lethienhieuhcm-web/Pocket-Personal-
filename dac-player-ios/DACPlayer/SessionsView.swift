import SwiftUI

/// 4.7: Quản lý phiên đăng nhập — trang riêng (không modal).
/// Liệt kê thiết bị đang đăng nhập, thu hồi từng phiên hoặc tất cả.
struct SessionsView: View {
    @EnvironmentObject var auth: AuthManager
    @State private var sessions: [LoginSession] = []
    @State private var statusText = ""
    @State private var isLoading = false

    var body: some View {
        List {
            Section {
                Button("Đăng xuất tất cả thiết bị khác") {
                    Task { await revokeOthers() }
                }
                .disabled(isLoading || sessions.filter({ !$0.current }).isEmpty)
            } footer: {
                Text("Các thiết bị đang đăng nhập tài khoản của bạn.")
            }

            Section {
                if isLoading && sessions.isEmpty {
                    ProgressView("Đang tải…")
                } else if sessions.isEmpty {
                    Text("Không có phiên nào.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(sessions) { s in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(s.deviceLabel)
                                        .font(.headline)
                                    if s.current {
                                        Text("Thiết bị này")
                                            .font(.caption)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(.secondary.opacity(0.2))
                                            .clipShape(Capsule())
                                    }
                                }
                                Text("\(s.ip.isEmpty ? "IP không rõ" : s.ip) · \(relative(s.lastActiveDate))")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if !s.current {
                                Button("Thu hồi") {
                                    Task { await revokeOne(s) }
                                }
                                .buttonStyle(.bordered)
                                .tint(.red)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            if !statusText.isEmpty {
                Section {
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Phiên đăng nhập")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            sessions = try await auth.listSessions()
            statusText = ""
        } catch {
            statusText = "Lỗi: \(errorMessage(error))"
        }
    }

    private func revokeOne(_ s: LoginSession) async {
        do {
            let n = try await auth.revokeSession(prefix: s.token_prefix)
            statusText = n > 0 ? "Đã thu hồi phiên." : "Không tìm thấy phiên."
            await load()
        } catch {
            statusText = "Lỗi: \(errorMessage(error))"
        }
    }

    private func revokeOthers() async {
        do {
            let n = try await auth.revokeAllOthers()
            statusText = "Đã đăng xuất \(n) thiết bị khác."
            await load()
        } catch {
            statusText = "Lỗi: \(errorMessage(error))"
        }
    }

    private func relative(_ date: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }

    private func errorMessage(_ error: Error) -> String {
        if case AuthError.message(let m) = error { return m }
        return error.localizedDescription
    }
}
