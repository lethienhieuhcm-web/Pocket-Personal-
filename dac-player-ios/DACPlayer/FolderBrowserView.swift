import SwiftUI

/// Duyệt nhạc theo thư mục Drive — dac-app 4.1.
///
/// - Breadcrumb bấm được để nhảy tới cấp bất kỳ.
/// - Bấm thư mục → drill xuống; bấm bài → phát ngay.
/// - Dùng chung AudioEngine với LibraryView (nhạc không dừng khi chuyển tab).
struct FolderBrowserView: View {
    @EnvironmentObject var driveAuth: DriveAuthManager
    @EnvironmentObject var api: MusicApiClient
    @EnvironmentObject var engine: AudioEngine

    @State private var currentId: String = "root"
    @State private var navStack: [String] = []
    @State private var breadcrumb: [BreadcrumbItem] = []
    @State private var folders: [DriveFolder] = []
    @State private var tracks: [Track] = []
    @State private var statusText: String? = nil
    @State private var isLoading = false
    @StateObject private var offline = OfflineManager.shared

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Breadcrumb — cuộn ngang, bấm để nhảy tới
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(Array(breadcrumb.enumerated()), id: \.offset) { i, crumb in
                            if i > 0 { Text("/").foregroundStyle(.secondary) }
                            Button(crumb.name.isEmpty ? "Drive" : crumb.name) {
                                jumpTo(crumb.id)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.blue)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 8)
                }
                Divider()

                if isLoading && folders.isEmpty && tracks.isEmpty {
                    Spacer()
                    ProgressView("Đang tải…")
                    Spacer()
                } else {
                    List {
                        Section {
                            ForEach(folders) { folder in
                                Button {
                                    drillDown(folder)
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: "folder.fill")
                                            .foregroundStyle(.blue)
                                            .font(.title3)
                                        Text(folder.name.isEmpty ? "(không tên)" : folder.name)
                                            .lineLimit(1)
                                        Spacer()
                                        Image(systemName: "chevron.right")
                                            .foregroundStyle(.secondary)
                                            .font(.footnote)
                                    }
                                }
                            }
                        } header: {
                            if !folders.isEmpty { Text("Thư mục") }
                        }

                        Section {
                            ForEach(tracks) { track in
                                HStack(spacing: 12) {
                                    Button {
                                        Task { await playTrack(track) }
                                    } label: {
                                        HStack(spacing: 12) {
                                            TrackArtworkView(track: track)
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(track.displayTitle).lineLimit(1)
                                                Text(formatSize(track.size))
                                                    .font(.footnote)
                                                    .foregroundStyle(.secondary)
                                            }
                                        }
                                    }
                                    .buttonStyle(.plain)
                                    Spacer()
                                    // 4.3: tải về nghe offline (bấm lần nữa = xoá)
                                    Button {
                                        Task { await downloadTrack(track) }
                                    } label: {
                                        Image(systemName: offline.downloadedIds.contains(track.id)
                                              ? "checkmark.circle.fill" : "arrow.down.circle")
                                            .foregroundStyle(.blue)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        } header: {
                            if !tracks.isEmpty { Text("Bài hát") }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await load(id: currentId) }
                }

                if let statusText {
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(8)
                }
            }
            .navigationTitle("Thư mục")
            .navigationBarTitleDisplayMode(.inline)
            .task { await load(id: "root") }
        }
    }

    private func load(id: String) async {
        currentId = id
        isLoading = true
        defer { isLoading = false }
        do {
            // 4.2: Đồng bộ index trước khi duyệt (chỉ khi mở tab lần đầu).
            if id == "root" && breadcrumb.isEmpty {
                statusText = "Đang đồng bộ thư viện…"
                do {
                    let r = try await api.syncIndex()
                    statusText = r.full
                        ? "Đã đồng bộ \(r.total) file (lần đầu)."
                        : "Đã đồng bộ (\(r.synced) thay đổi)."
                } catch {
                    // Sync lỗi → vẫn duyệt bằng live Drive (fallback ở Worker)
                    statusText = "Đồng bộ lỗi, dùng dữ liệu trực tiếp."
                }
            }
            let listing = try await api.listFolders(parentId: id)
            breadcrumb = listing.breadcrumb
            folders = listing.folders
            tracks = listing.tracks
            statusText = "\(listing.folders.count) thư mục • \(listing.tracks.count) bài"
        } catch MusicError.driveTokenInvalid {
            driveAuth.clear()
        } catch {
            statusText = "Không tải được: \(error.localizedDescription)"
        }
    }

    /// 4.3: phát track — ưu tiên file offline đã tải. 4.5: + prefetch queue gapless.
    private func playTrack(_ track: Track) async {
        await engine.playWithQueue(track, from: tracks, via: api)
    }

    /// 4.3: tải track về nghe offline. Bấm lần nữa khi đã tải = xoá.
    private func downloadTrack(_ track: Track) async {
        if offline.isDownloaded(trackId: track.id) {
            offline.delete(trackId: track.id)
            statusText = "Đã xoá bản offline: \(track.title)"
            return
        }
        do {
            statusText = "Đang tải: \(track.title)"
            let url = try await api.streamURL(for: track.id)
            try await offline.download(trackId: track.id, title: track.title, from: url)
            statusText = "Đã tải xong: \(track.title)"
        } catch {
            statusText = "Không tải được: \(error.localizedDescription)"
        }
    }

    private func drillDown(_ folder: DriveFolder) {        navStack.append(currentId)
        Task { await load(id: folder.id) }
    }

    private func jumpTo(_ id: String) {
        let trail = navStack + [currentId]
        if let idx = trail.firstIndex(of: id) {
            let drop = trail.count - 1 - idx
            if drop > 0 { navStack.removeLast(drop) }
        } else {
            navStack.removeAll()
        }
        Task { await load(id: id) }
    }

    private func formatSize(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_048_576
        if mb >= 1 { return String(format: "%.1f MB", mb) }
        return String(format: "%d KB", max(bytes / 1024, 1))
    }
}
