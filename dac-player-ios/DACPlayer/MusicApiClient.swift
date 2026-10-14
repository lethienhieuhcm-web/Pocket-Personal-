import Foundation

/// Client gọi Worker API — dịch từ MusicApiClient.kt (Android).
///
/// Kiến trúc dac-pass: [Drive user] → [Worker verify + passthrough] → [App] → [USB DAC]
/// Mỗi request gửi 2 header: Authorization (PP session) + X-Drive-Token.
/// Worker KHÔNG lưu token Drive. Danh sách nhạc cache 24h trên máy.
///
/// API contract:
///   GET /api/dac/music       → {files:[{id,name,size,mimeType}]}
///   GET /api/dac/stream/{id} → {url, name, mimeType, size}
struct Track: Identifiable, Codable, Hashable {
    let id: String
    let title: String
    let size: Int64
    let mimeType: String
}

private struct MusicCache: Codable {
    let cachedAt: Int64  // epoch millis
    let tracks: [Track]
}

private struct StreamResponse: Codable {
    let url: String
    let name: String
    let mimeType: String
    let size: Int64
}

@MainActor
class MusicApiClient: ObservableObject {
    static let cacheTTLms: Int64 = 24 * 60 * 60 * 1000

    private let auth: AuthManager
    private let driveToken: () -> String?

    @Published private(set) var tracks: [Track] = []

    init(auth: AuthManager, driveToken: @escaping () -> String?) {
        self.auth = auth
        self.driveToken = driveToken
        self.tracks = (try? loadCache()) ?? []
    }

    private var cacheURL: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("dac-music-cache.json")
    }

    private func loadCache() throws -> [Track] {
        let data = try Data(contentsOf: cacheURL)
        let cache = try JSONDecoder().decode(MusicCache.self, from: data)
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        guard now - cache.cachedAt < Self.cacheTTLms else { return [] }
        return cache.tracks
    }

    private func saveCache(_ tracks: [Track]) {
        let cache = MusicCache(cachedAt: Int64(Date().timeIntervalSince1970 * 1000), tracks: tracks)
        if let data = try? JSONEncoder().encode(cache) {
            try? data.write(to: cacheURL)
        }
    }

    /// GET Worker API. Throw nếu lỗi.
    private func get(_ path: String) async throws -> Data {
        guard let token = auth.token() else {
            throw MusicError.message("Chưa đăng nhập")
        }
        let url = URL(string: AuthManager.baseURL + path)!
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let dt = driveToken() {
            req.setValue(dt, forHTTPHeaderField: "X-Drive-Token")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        switch code {
        case 200:
            return data
        case 401:
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data),
               err.error.contains("Drive token invalid") {
                throw MusicError.driveTokenInvalid
            }
            throw MusicError.message("Hết phiên đăng nhập (401)")
        default:
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data),
               !err.error.isEmpty {
                throw MusicError.message(err.error)
            }
            throw MusicError.message("API lỗi: HTTP \(code)")
        }
    }

    /// Lấy danh sách nhạc từ Drive qua Worker. Cache 24h, forceRefresh để bỏ qua.
    @discardableResult
    func listMusic(forceRefresh: Bool = false) async throws -> [Track] {
        if !forceRefresh, let cached = try? loadCache(), !cached.isEmpty {
            tracks = cached
            return cached
        }
        let data = try await get("/api/dac/music")
        let resp = try JSONDecoder().decode(MusicListResponse.self, from: data)
        let list = resp.files.map { f -> Track in
            let ns = f.name as NSString
            let title = ns.pathExtension.isEmpty ? f.name : ns.deletingPathExtension
            return Track(id: f.id, title: title, size: f.size, mimeType: f.mimeType)
        }
        saveCache(list)
        tracks = list
        return list
    }

    /// Tìm kiếm trong cache offline.
    func searchOffline(_ query: String) -> [Track] {
        let q = query.lowercased()
        guard !q.isEmpty else { return tracks }
        return tracks.filter { $0.title.lowercased().contains(q) }
    }

    /// Xoá cache danh sách nhạc.
    func clearCache() {
        try? FileManager.default.removeItem(at: cacheURL)
        tracks = []
    }

    /// Lấy direct Drive URL để stream.
    func streamURL(for id: String) async throws -> URL {
        let data = try await get("/api/dac/stream/\(id)")
        let resp = try JSONDecoder().decode(StreamResponse.self, from: data)
        guard let url = URL(string: resp.url) else {
            throw MusicError.message("URL stream không hợp lệ")
        }
        return url
    }
}

enum MusicError: Error {
    case message(String)
    /// Drive token hết hạn/sai — khác với hết phiên đăng nhập.
    /// UI bắt riêng để hiện "kết nối lại Drive".
    case driveTokenInvalid
}
