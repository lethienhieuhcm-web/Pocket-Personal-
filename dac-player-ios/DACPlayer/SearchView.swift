import SwiftUI

/// 4.8: Tìm kiếm metadata (D1 index) — tab riêng.
/// Phân trang: nút "Tải thêm" khi còn kết quả. Bấm bài → phát + prefetch queue (4.5).
struct SearchView: View {
    @EnvironmentObject var api: MusicApiClient
    @EnvironmentObject var engine: AudioEngine
    @EnvironmentObject var offline: OfflineManager

    @State private var query = ""
    @State private var tracks: [Track] = []
    @State private var total = 0
    @State private var isLoading = false
    @State private var statusText = ""
    @State private var showPlayer = false

    private let pageSize = 50

    private var hasMore: Bool {
        total < 0 ? false : tracks.count < total
    }

    var body: some View {
        NavigationStack {
            List {
                if isLoading && tracks.isEmpty {
                    ProgressView("Đang tìm…")
                } else if tracks.isEmpty && !query.isEmpty && !isLoading {
                    Text("Không tìm thấy kết quả.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(tracks) { track in
                        Button {
                            Task {
                                // 4.5: phát + prefetch queue gapless
                                await engine.playWithQueue(track, from: tracks, via: api)
                                showPlayer = true
                            }
                        } label: {
                            HStack(spacing: 12) {
                                TrackArtworkView(track: track)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(track.displayTitle)
                                        .lineLimit(1)
                                    Text(formatSize(track.size))
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                Spacer()
                                // 4.3: nút tải offline
                                Button {
                                    Task { await downloadTrack(track) }
                                } label: {
                                    Image(systemName: offline.isDownloaded(trackId: track.id)
                                          ? "trash" : "arrow.down.circle")
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    if hasMore {
                        Button(isLoading ? "Đang tải…" : "Tải thêm") {
                            Task { await loadMore() }
                        }
                        .disabled(isLoading)
                    }
                }

                if !statusText.isEmpty {
                    Text(statusText)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Tìm kiếm")
            .searchable(text: $query, prompt: "Tên bài hát, nghệ sĩ…")
            .onSubmit(of: .search) {
                Task { await doSearch() }
            }
            .sheet(isPresented: $showPlayer) {
                PlayerView()
            }
        }
    }

    private func doSearch() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        isLoading = true
        statusText = ""
        defer { isLoading = false }
        do {
            let res = try await api.search(query: q, limit: pageSize, offset: 0)
            tracks = res.tracks
            total = res.total
            if total >= 0 {
                statusText = "Tìm thấy \(total) kết quả."
            }
        } catch MusicError.driveTokenInvalid {
            statusText = "Drive token hết hạn. Kết nối lại Drive."
        } catch {
            statusText = "Lỗi tìm kiếm: \(error.localizedDescription)"
        }
    }

    private func loadMore() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let res = try await api.search(query: query, limit: pageSize, offset: tracks.count)
            tracks.append(contentsOf: res.tracks)
            total = res.total
        } catch {
            statusText = "Lỗi tải thêm: \(error.localizedDescription)"
        }
    }

    private func downloadTrack(_ track: Track) async {
        if offline.isDownloaded(trackId: track.id) {
            offline.delete(trackId: track.id)
            return
        }
        do {
            let url = try await api.streamURL(for: track.id)
            try await offline.download(trackId: track.id, title: track.title, from: url)
        } catch {
            statusText = "Lỗi tải: \(error.localizedDescription)"
        }
    }

    private func formatSize(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_048_576
        return mb >= 1 ? String(format: "%.1f MB", mb) : "\(bytes / 1024) KB"
    }
}
