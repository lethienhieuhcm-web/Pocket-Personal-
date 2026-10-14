import SwiftUI

/// Màn hình nhập nhạc từ link Drive share — dịch từ ImportActivity (Android).
/// Paste link → xem danh sách → chọn file → copy → tiến trình x/y.
struct ImportView: View {
    @EnvironmentObject var auth: AuthManager
    @EnvironmentObject var driveAuth: DriveAuthManager
    @EnvironmentObject var copyManager: DriveCopyManager
    @Environment(\.dismiss) private var dismiss

    @State private var link = ""
    @State private var resolved: ResolveResponse? = nil
    @State private var selected: Set<String> = []
    @State private var errorText: String? = nil
    @State private var infoText: String? = nil
    @State private var isResolving = false
    @State private var isCopying = false
    @State private var copyProgress = ""

    var body: some View {
        // 4.8: không dùng .sheet (cấm modal) — view này luôn được push qua
        // navigationDestination từ Library nên không cần NavigationStack riêng.
            VStack(spacing: 16) {
                if !driveAuth.isConnected {
                    VStack(spacing: 8) {
                        Text("Cần kết nối Google Drive trước khi nhập nhạc.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Kết nối Google Drive") {
                            Task { await driveAuth.signIn() }
                        }
                        .buttonStyle(.borderedProminent)
                        if let err = driveAuth.errorMessage {
                            Text(err)
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }

                TextField("Dán link Google Drive share", text: $link)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()

                Button("Xem nội dung link") {
                    Task { await doResolve() }
                }
                .buttonStyle(.borderedProminent)
                .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || isResolving || isCopying || !driveAuth.isConnected)

                if let errorText {
                    Text(errorText)
                        .foregroundStyle(.red)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                }
                if let infoText {
                    Text(infoText)
                        .foregroundStyle(.green)
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                }

                if let resolved {
                    Text(resolved.name)
                        .font(.headline)
                        .lineLimit(2)
                    Text("\(resolved.files.count) file nhạc")
                        .font(.footnote)
                        .foregroundStyle(.secondary)

                    List(resolved.files, id: \.id) { file in
                        Button {
                            if selected.contains(file.id) {
                                selected.remove(file.id)
                            } else {
                                selected.insert(file.id)
                            }
                        } label: {
                            HStack {
                                Image(systemName: selected.contains(file.id)
                                      ? "checkmark.circle.fill" : "circle")
                                VStack(alignment: .leading) {
                                    Text(file.name).lineLimit(1)
                                    Text(formatSize(file.size))
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .listStyle(.plain)

                    if isCopying {
                        Text(copyProgress)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    Button(selected.count == resolved.files.count
                           ? "Bỏ chọn tất cả" : "Chọn tất cả") {
                        if selected.count == resolved.files.count {
                            selected.removeAll()
                        } else {
                            selected = Set(resolved.files.map(\.id))
                        }
                    }
                    .font(.footnote)

                    Button("Copy \(selected.count) file vào Drive của tôi") {
                        Task { await doCopy() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selected.isEmpty || isCopying)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Nhập từ link")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Đóng") { dismiss() }
                }
            }
    }

    private func doResolve() async {
        errorText = nil
        infoText = nil
        resolved = nil
        selected.removeAll()
        isResolving = true
        defer { isResolving = false }
        do {
            let r = try await copyManager.resolve(link: link)
            resolved = r
            selected = Set(r.files.map(\.id))
        } catch CopyError.driveTokenInvalid {
            driveAuth.clear()
            errorText = "Drive token hết hạn. Vui lòng kết nối lại Google Drive."
        } catch CopyError.message(let msg) {
            errorText = msg
        } catch {
            errorText = "Lỗi mạng. Kiểm tra kết nối và thử lại."
        }
    }

    private func doCopy() async {
        guard let resolved else { return }
        errorText = nil
        infoText = nil
        isCopying = true
        defer { isCopying = false }
        let files = resolved.files.filter { selected.contains($0.id) }
        var okCount = 0
        var scopeError: String? = nil
        for (i, file) in files.enumerated() {
            copyProgress = "Đang copy \(i + 1)/\(files.count): \(file.name)"
            do {
                _ = try await copyManager.copy(sourceId: file.id)
                okCount += 1
            } catch let e as CopyScopeError {
                scopeError = e.message
                break
            } catch CopyError.driveTokenInvalid {
                driveAuth.clear()
                errorText = "Drive token hết hạn. Vui lòng kết nối lại Google Drive."
                break
            } catch {
                // Tiếp tục file khác, không dừng cả đợt
            }
        }
        copyProgress = ""
        if let scopeError {
            errorText = scopeError
        } else if okCount == files.count {
            infoText = "Copy xong \(okCount)/\(files.count) file. Vào Thư viện → kéo để làm mới."
        } else {
            infoText = "Copy được \(okCount)/\(files.count) file."
        }
    }

    private func formatSize(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_048_576
        if mb >= 1 { return String(format: "%.1f MB", mb) }
        return String(format: "%d KB", max(bytes / 1024, 1))
    }
}
