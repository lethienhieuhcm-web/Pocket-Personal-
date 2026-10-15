import SwiftUI

/// v3.0: Màn hình Bộ nhớ — quản lý file nhạc offline.
/// Hiện dung lượng đã dùng, nút xoá tất cả, cảnh báo khi sắp hết.
struct StorageView: View {
    @StateObject private var offline = OfflineManager.shared
    @State private var usedBytes: Int64 = 0
    @State private var freeBytes: Int64 = 0
    @State private var showConfirm = false

    var body: some View {
        List {
            Section("Bộ nhớ") {
                HStack {
                    Text("Đã dùng (offline)")
                    Spacer()
                    Text(fmtSize(usedBytes)).foregroundColor(.secondary)
                }
                HStack {
                    Text("Còn trống")
                    Spacer()
                    Text(fmtSize(freeBytes))
                        .foregroundColor(freeBytes < 1024*1024*1024 ? .red : .secondary)
                }
                HStack {
                    Text("Số file offline")
                    Spacer()
                    Text("\(offline.downloadedIds.count)").foregroundColor(.secondary)
                }
            }
            Section {
                Button(role: .destructive) {
                    showConfirm = true
                } label: {
                    Text("Xoá tất cả file offline")
                }
            } footer: {
                Text("File trên Google Drive không bị ảnh hưởng.")
            }
        }
        .navigationTitle("Bộ nhớ")
        .alert("Xoá tất cả?", isPresented: $showConfirm) {
            Button("Xoá", role: .destructive) { clearAll() }
            Button("Huỷ", role: .cancel) {}
        } message: {
            Text("Sẽ xoá \(offline.downloadedIds.count) file đã tải về.")
        }
        .onAppear { refresh() }
    }

    private func refresh() {
        var total: Int64 = 0
        for id in offline.downloadedIds {
            if let url = offline.localFile(trackId: id),
               let attr = try? FileManager.default.attributesOfItem(atPath: url.path),
               let size = attr[.size] as? Int64 {
                total += size
            }
        }
        usedBytes = total
        if let attr = try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()),
           let free = attr[.systemFreeSize] as? Int64 {
            freeBytes = free
        }
    }

    private func clearAll() {
        for id in offline.downloadedIds {
            offline.delete(trackId: id)
        }
        refresh()
    }

    private func fmtSize(_ bytes: Int64) -> String {
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: bytes)
    }
}
