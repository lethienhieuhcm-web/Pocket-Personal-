import Foundation
import Combine

/// 4.3: Quản lý file nhạc tải về để nghe offline.
///
/// - File lưu ở Documents/offline/{trackId}.{ext} (app-private).
/// - Index [trackId: fileName] lưu UserDefaults.
/// - Phát nhạc kiểm tra `localFile` trước khi stream.
/// Theo big-tech (Spotify/YouTube Music): download per-track, user chủ động.
@MainActor
class OfflineManager: ObservableObject {
    static let shared = OfflineManager()

    @Published private(set) var downloadedIds: Set<String> = []

    private let fm = FileManager.default
    private let indexKey = "dac-offline-index"

    private var dir: URL {
        fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("offline")
    }

    private var index: [String: String] {
        get { UserDefaults.standard.dictionary(forKey: indexKey) as? [String: String] ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: indexKey) }
    }

    init() {
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        refresh()
    }

    /// File local của track, hoặc nil nếu chưa tải.
    func localFile(trackId: String) -> URL? {
        guard let name = index[trackId] else { return nil }
        let url = dir.appendingPathComponent(name)
        return (fm.fileExists(atPath: url.path) ? url : nil)
    }

    func isDownloaded(trackId: String) -> Bool {
        localFile(trackId: trackId) != nil
    }

    /// Tải track về máy. Ghi file tạm rồi rename (atomic).
    func download(trackId: String, title: String, from url: URL) async throws {
        let ext = Self.extForFileName(title)
        let name = Self.fileNameFor(trackId: trackId, ext: ext)
        let tmp = dir.appendingPathComponent(name + ".tmp")
        let dest = dir.appendingPathComponent(name)
        let (tmpURL, resp) = try await URLSession.shared.download(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200 else {
            throw MusicError.message("Tải thất bại")
        }
        try? fm.removeItem(at: tmp)
        try fm.moveItem(at: tmpURL, to: tmp)
        try? fm.removeItem(at: dest)
        try fm.moveItem(at: tmp, to: dest)
        var idx = index
        idx[trackId] = name
        index = idx
        refresh()
    }

    /// Xoá file offline (giải phóng bộ nhớ).
    func delete(trackId: String) {
        if let name = index[trackId] {
            try? fm.removeItem(at: dir.appendingPathComponent(name))
        }
        var idx = index
        idx.removeValue(forKey: trackId)
        index = idx
        refresh()
    }

    private func refresh() {
        downloadedIds = Set(index.keys.filter { isDownloaded(trackId: $0) })
    }

    // MARK: - Logic thuần (test được)

    /// Đuôi file từ tên track — mặc định mp3.
    static func extForFileName(_ name: String) -> String {
        let ext = (name as NSString).pathExtension.lowercased()
        let ok = (2...5).contains(ext.count) && ext.allSatisfy { $0.isLetter || $0.isNumber }
        return ok ? ext : "mp3"
    }

    /// Tên file local: {trackId}.{ext} — trackId Drive là duy nhất.
    static func fileNameFor(trackId: String, ext: String) -> String {
        let safe = trackId.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
        return "\(safe).\(ext)"
    }
}
