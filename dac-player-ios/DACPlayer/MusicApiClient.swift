import Foundation
import GoogleSignIn

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
    /// 4.8: artist parse từ tên file; rỗng nếu không khớp quy ước.
    var artist: String = ""
    /// Redesign 80/20: album từ /api/dac/library
    var album: String = ""

    /// Tên hiển thị: "Nghệ sĩ - Tên bài" khi có artist.
    var displayTitle: String {
        artist.isEmpty ? title : "\(artist) - \(title)"
    }
}

private struct LibraryFile: Codable {
    let id: String
    let title: String
    let artist: String
    let album: String
    let size: Int64
    let mimeType: String
}
private struct LibraryResponse: Codable {
    let files: [LibraryFile]
    let lastSync: Int64?
}

private struct MusicCache: Codable {
    let cachedAt: Int64  // epoch millis
    let tracks: [Track]
}

private struct SearchResponse: Codable {
    var files: [SearchFile] = []
    var total: Int = 0
}

private struct SearchFile: Codable {
    var id: String = ""
    var name: String = ""
    var artist: String = ""
    var title: String = ""
    var size: Int64 = 0
    var mimeType: String = ""
}

struct SearchResult {
    var tracks: [Track]
    var total: Int
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
    /// Đồng bộ thông minh: timestamp lần sync cuối (ms)
    @Published private(set) var lastSync: Int64 = 0

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
        try await request(path, method: "GET")
    }

    /// POST Worker API (body rỗng). Throw nếu lỗi.
    private func post(_ path: String) async throws -> Data {
        try await request(path, method: "POST")
    }

    /// 4.9: POST JSON.
    private func postJson(_ path: String, body: Data) async throws -> Data {
        try await requestWithBody(path, method: "POST", body: body)
    }

    /// 4.9: PUT JSON.
    private func put(_ path: String, body: Data) async throws -> Data {
        try await requestWithBody(path, method: "PUT", body: body)
    }

    /// 4.9: DELETE.
    private func delete(_ path: String) async throws {
        _ = try await request(path, method: "DELETE")
    }

    private func requestWithBody(_ path: String, method: String, body: Data) async throws -> Data {
        var refreshed = false
        while true {
            do {
                return try await performRequest(path, method: method, body: body)
            } catch MusicError.driveTokenInvalid {
                if refreshed { throw MusicError.driveTokenInvalid }
                refreshed = true
                try? await GIDSignIn.sharedInstance.currentUser?.refreshTokensIfNeeded()
            }
        }
    }

    /// 4.3: backoff cho retry — exponential 1s → 2s → 4s (cap 8s) + jitter.
    static func backoffNs(_ attempt: Int) -> UInt64 {
        let base = min(1_000_000_000 * (1 << (attempt - 1)), 8_000_000_000)
        return UInt64(base) + UInt64.random(in: 0...500_000_000)
    }

    /**
     * 4.6: Gọi API với Drive token, tự refresh + thử lại 1 lần khi Worker báo 401.
     * OAuth chuẩn: SDK giữ refresh token trong Keychain; refreshTokensIfNeeded()
     * lấy access token mới mà app không bao giờ thấy refresh token.
     * Hết 1 lần retry vẫn 401 → throw để UI hiện "kết nối lại Drive".
     */
    private func request(_ path: String, method: String) async throws -> Data {
        var refreshed = false
        while true {
            do {
                return try await performRequest(path, method: method)
            } catch MusicError.driveTokenInvalid {
                if refreshed { throw MusicError.driveTokenInvalid }
                refreshed = true
                try? await GIDSignIn.sharedInstance.currentUser?.refreshTokensIfNeeded()
            }
        }
    }

    private func performRequest(_ path: String, method: String, body: Data? = nil) async throws -> Data {
        guard let token = auth.token() else {
            throw MusicError.message("Chưa đăng nhập")
        }
        let url = URL(string: AuthManager.baseURL + path)!
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body = body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let dt = driveToken() {
            req.setValue(dt, forHTTPHeaderField: "X-Drive-Token")
        }
        // 4.3: retry — chỉ GET/HEAD (idempotent) khi 429/503 hoặc lỗi mạng.
        // POST (sync/copy) không retry mù để tránh ghi trùng.
        let idempotent = (method == "GET" || method == "HEAD")
        var attempt = 0
        while true {
            attempt += 1
            let data: Data
            let resp: URLResponse
            do {
                (data, resp) = try await URLSession.shared.data(for: req)
            } catch {
                if idempotent && attempt < 3 {
                    try await Task.sleep(nanoseconds: Self.backoffNs(attempt))
                    continue
                }
                throw error
            }
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if (code == 429 || code == 503) && idempotent && attempt < 3 {
                try await Task.sleep(nanoseconds: Self.backoffNs(attempt))
                continue
            }
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
    }

    /// Redesign 80/20: lấy từ /api/dac/library (có artist/title/album)
    @discardableResult
    func listLibrary(forceRefresh: Bool = false) async throws -> [Track] {
        if !forceRefresh, let cached = try? loadCache(), !cached.isEmpty {
            tracks = cached
            return cached
        }
        let data = try await get("/api/dac/library?limit=200")
        let resp = try JSONDecoder().decode(LibraryResponse.self, from: data)
        let list = resp.files.map { f -> Track in
            var t = Track(id: f.id, title: f.title, size: f.size, mimeType: f.mimeType)
            t.artist = f.artist
            t.album = f.album
            return t
        }
        saveCache(list)
        tracks = list
        lastSync = resp.lastSync ?? 0
        return list

    /// Đồng bộ thông minh: gọi POST /api/dac/sync rồi refresh library
    func syncLibrary() async {
        do {
            _ = try await post("/api/dac/sync")
            _ = try await listLibrary(forceRefresh: true)
        } catch {
            // lỗi thì im lặng giữ cache
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

    /// 4.2: Đồng bộ index Drive vào D1 — POST /api/dac/sync.
    /// Lần đầu full scan (lâu), các lần sau incremental (nhanh).
    struct SyncResult: Codable {
        let full: Bool
        let synced: Int
        let total: Int
    }

    func syncIndex() async throws -> SyncResult {
        let data = try await post("/api/dac/sync")
        return try JSONDecoder().decode(SyncResult.self, from: data)
    }

    /// 4.1: Duyệt thư mục Drive — GET /api/dac/folders?parentId=...
    /// Trả về breadcrumb + thư mục con + file nhạc trong thư mục hiện tại.
    struct FolderListing {
        let parentId: String
        let parentName: String
        let breadcrumb: [BreadcrumbItem]
        let folders: [DriveFolder]
        let tracks: [Track]
    }

    func listFolders(parentId: String = "root") async throws -> FolderListing {
        let q = parentId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? "root"
        let data = try await get("/api/dac/folders?parentId=\(q)")
        let resp = try JSONDecoder().decode(FolderListResponse.self, from: data)
        let tracks = resp.tracks.map { f -> Track in
            let ns = f.name as NSString
            let title = ns.pathExtension.isEmpty ? f.name : ns.deletingPathExtension
            return Track(id: f.id, title: title, size: f.size, mimeType: f.mimeType)
        }
        return FolderListing(
            parentId: resp.parentId,
            parentName: resp.parentName,
            breadcrumb: resp.breadcrumb,
            folders: resp.folders,
            tracks: tracks
        )
    }

    /// Lấy direct Drive URL để stream.
    /// 4.8: Tìm kiếm metadata trong D1 index (phân trang).
    /// Chưa sync → Worker fallback tìm live Drive (total=-1).
    func search(query: String, limit: Int = 50, offset: Int = 0) async throws -> SearchResult {
        // 4.6: 401 drive-token-invalid → refresh token + thử lại 1 lần.
        var refreshed = false
        while true {
            do {
                return try await performSearch(query: query, limit: limit, offset: offset)
            } catch MusicError.driveTokenInvalid {
                if refreshed { throw MusicError.driveTokenInvalid }
                refreshed = true
                try? await GIDSignIn.sharedInstance.currentUser?.refreshTokensIfNeeded()
            }
        }
    }

    private func performSearch(query: String, limit: Int, offset: Int) async throws -> SearchResult {
        var comp = URLComponents(string: AuthManager.baseURL + "/api/dac/search")!
        comp.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset)),
        ]
        let url = comp.url!
        var req = URLRequest(url: url)
        guard let token = auth.token() else {
            throw MusicError.message("Chưa đăng nhập")
        }
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let dt = driveToken() {
            req.setValue(dt, forHTTPHeaderField: "X-Drive-Token")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 401 {
            if let err = try? JSONDecoder().decode(ErrorResponse.self, from: data),
               err.error.contains("Drive token invalid") {
                throw MusicError.driveTokenInvalid
            }
            throw MusicError.message("Hết phiên đăng nhập (401)")
        }
        guard code == 200 else {
            throw MusicError.message("Tìm kiếm lỗi: HTTP \(code)")
        }
        let decoded = try JSONDecoder().decode(SearchResponse.self, from: data)
        let tracks = decoded.files.map { f in
            Track(id: f.id, title: f.title.isEmpty ? f.name : f.title,
                  size: f.size, mimeType: f.mimeType, artist: f.artist)
        }
        return SearchResult(tracks: tracks, total: decoded.total)
    }

    func streamURL(for id: String) async throws -> URL {
        let data = try await get("/api/dac/stream/\(id)")
        let resp = try JSONDecoder().decode(StreamResponse.self, from: data)
        guard let url = URL(string: resp.url) else {
            throw MusicError.message("URL stream không hợp lệ")
        }
        return url
    }

    // MARK: - 4.9: Playlist lưu trên D1 (đồng bộ giữa 2 máy)

    struct PlaylistSummary: Codable, Identifiable {
        var id: String
        var name: String
        var itemCount: Int = 0
    }

    struct PlaylistItem: Codable {
        var fileId: String = ""
        var name: String = ""
        var artist: String = ""
        var title: String = ""
        var mimeType: String = ""
        var size: Int64 = 0
    }

    private struct PlaylistListResponse: Codable {
        var playlists: [PlaylistSummary] = []
    }

    private struct PlaylistDetailResponse: Codable {
        var id: String = ""
        var name: String = ""
        var items: [PlaylistItem] = []
    }

    private struct PlaylistIdResponse: Codable {
        var id: String = ""
        var name: String = ""
    }

    private struct PlaylistItemsRequest: Codable {
        var items: [PlaylistItem]
    }

    /// Lấy danh sách playlist của user.
    func listPlaylists() async throws -> [PlaylistSummary] {
        let data = try await get("/api/dac/playlists")
        return try JSONDecoder().decode(PlaylistListResponse.self, from: data).playlists
    }

    /// Tạo playlist mới, trả về id.
    func createPlaylist(name: String) async throws -> String {
        let body = try JSONEncoder().encode(["name": name])
        let data = try await postJson("/api/dac/playlists", body: body)
        return try JSONDecoder().decode(PlaylistIdResponse.self, from: data).id
    }

    /// Xoá playlist (kèm items).
    func deletePlaylist(id: String) async throws {
        try await delete("/api/dac/playlists/\(id)")
    }

    /// Lấy items của 1 playlist (đúng thứ tự).
    func getPlaylistItems(id: String) async throws -> [PlaylistItem] {
        let data = try await get("/api/dac/playlists/\(id)")
        return try JSONDecoder().decode(PlaylistDetailResponse.self, from: data).items
    }

    /// Thay toàn bộ items của playlist.
    func setPlaylistItems(id: String, items: [PlaylistItem]) async throws {
        let body = try JSONEncoder().encode(PlaylistItemsRequest(items: items))
        _ = try await put("/api/dac/playlists/\(id)", body: body)
    }
}

enum MusicError: Error {
    case message(String)
    /// Drive token hết hạn/sai — khác với hết phiên đăng nhập.
    /// UI bắt riêng để hiện "kết nối lại Drive".
    case driveTokenInvalid
}
