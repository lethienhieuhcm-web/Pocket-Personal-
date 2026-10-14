import SwiftUI

/// 4.9: Hàng chờ + hẹn giờ ngủ + playlist — trang full-page (không modal/bottom sheet).
/// - Kéo-thả đổi thứ tự (không di chuyển được bài đang phát), vuốt để xoá.
/// - Hẹn giờ: Tắt / 15 / 30 / 60 phút / Hết bài.
/// - Playlist: lưu hàng chờ lên D1, mở lại trên mọi máy.
struct QueueView: View {
    @EnvironmentObject var engine: AudioEngine
    @EnvironmentObject var api: MusicApiClient

    @State private var playlists: [MusicApiClient.PlaylistSummary] = []
    @State private var newPlaylistName: String = ""
    @State private var statusText: String = ""
    @State private var isBusy: Bool = false

    var body: some View {
        List {
            // --- Hàng chờ ---
            Section(header: Text("Hàng chờ (kéo để đổi thứ tự, vuốt để xoá)")) {
                if engine.queueSnapshot.isEmpty {
                    Text("Hàng chờ trống.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(engine.queueSnapshot.indices, id: \.self) { i in
                        let t = engine.queueSnapshot[i]
                        HStack {
                            Text("\(i + 1)")
                                .frame(width: 28)
                                .foregroundStyle(.secondary)
                            VStack(alignment: .leading) {
                                Text(t.displayTitle)
                                    .lineLimit(1)
                                if i == 0 {
                                    Text("Đang phát")
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    .onMove(perform: moveQueue)
                    .onDelete(perform: deleteQueue)
                }
            }

            // --- Hẹn giờ ngủ ---
            Section(header: Text("Hẹn giờ dừng phát")) {
                Text(engine.sleepStatusText)
                    .foregroundStyle(.secondary)
                HStack {
                    sleepButton("Tắt") { engine.cancelSleep() }
                    sleepButton("15p") { engine.startSleep(minutes: 15) }
                    sleepButton("30p") { engine.startSleep(minutes: 30) }
                    sleepButton("60p") { engine.startSleep(minutes: 60) }
                    sleepButton("Hết bài") { engine.startSleepEndOfTrack() }
                }
                .buttonStyle(.bordered)
            }

            // --- Playlist ---
            Section(header: Text("Playlist (lưu trên tài khoản, mở được mọi máy)")) {
                HStack {
                    TextField("Tên playlist mới", text: $newPlaylistName)
                    Button("Lưu hàng chờ") { saveQueueAsPlaylist() }
                        .disabled(isBusy)
                }
                if playlists.isEmpty {
                    Text("Chưa có playlist nào.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(playlists) { p in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(p.name).lineLimit(1)
                                Text("\(p.itemCount) bài")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("Mở") { loadPlaylist(p) }
                                .disabled(isBusy)
                            Button("Xoá") { deletePlaylist(p) }
                                .disabled(isBusy)
                                .foregroundStyle(.red)
                        }
                    }
                }
            }

            if !statusText.isEmpty {
                Section {
                    Text(statusText)
                        .foregroundStyle(.secondary)
                        .font(.footnote)
                }
            }
        }
        .navigationTitle("Hàng chờ")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { EditButton() }
        .task { await reloadPlaylists() }
    }

    private func sleepButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(label, action: action)
    }

    // MARK: - Queue reorder/delete

    private func moveQueue(from source: IndexSet, to destination: Int) {
        guard let from = source.first else { return }
        // Không cho di chuyển bài đang phát ([0]).
        guard from >= 1 else { return }
        var to = destination > from ? destination - 1 : destination
        // Không cho kéo lên trước bài đang phát.
        if to < 1 { to = 1 }
        engine.moveTrack(from: from, to: to)
    }

    private func deleteQueue(at offsets: IndexSet) {
        // removeTrack từ chối index 0 (bài đang phát) → tự bỏ qua.
        for i in offsets.sorted(by: >) {
            _ = engine.removeTrack(at: i)
        }
    }

    // MARK: - Playlist

    private func reloadPlaylists() async {
        do {
            playlists = try await api.listPlaylists()
        } catch {
            statusText = "Lỗi tải playlist: \(error.localizedDescription)"
        }
    }

    private func saveQueueAsPlaylist() {
        let name = newPlaylistName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else {
            statusText = "Nhập tên playlist."
            return
        }
        // Chỉ bài từ Drive (có file id) mới lưu được.
        let items = engine.queueSnapshot.compactMap { t -> MusicApiClient.PlaylistItem? in
            guard !t.id.isEmpty else { return nil }
            return MusicApiClient.PlaylistItem(
                fileId: t.id, name: t.title, artist: t.artist,
                title: t.title, mimeType: t.mimeType, size: t.size
            )
        }
        guard !items.isEmpty else {
            statusText = "Hàng chờ không có bài nào từ Drive để lưu."
            return
        }
        isBusy = true
        Task {
            defer { isBusy = false }
            do {
                let id = try await api.createPlaylist(name: String(name.prefix(80)))
                try await api.setPlaylistItems(id: id, items: items)
                newPlaylistName = ""
                statusText = "Đã lưu \"\(name)\" (\(items.count) bài)."
                await reloadPlaylists()
            } catch {
                statusText = "Lỗi lưu playlist: \(error.localizedDescription)"
            }
        }
    }

    private func loadPlaylist(_ p: MusicApiClient.PlaylistSummary) {
        isBusy = true
        statusText = "Đang mở \"\(p.name)\"…"
        Task {
            defer { isBusy = false }
            do {
                let items = try await api.getPlaylistItems(id: p.id)
                let tracks = items.map {
                    Track(id: $0.fileId,
                          title: $0.title.isEmpty ? $0.name : $0.title,
                          size: $0.size, mimeType: $0.mimeType, artist: $0.artist)
                }
                guard !tracks.isEmpty else {
                    statusText = "Playlist trống."
                    return
                }
                await engine.playAll(tracks, via: api)
                statusText = "Đang phát \"\(p.name)\" (\(tracks.count) bài)."
            } catch {
                statusText = "Lỗi mở playlist: \(error.localizedDescription)"
            }
        }
    }

    private func deletePlaylist(_ p: MusicApiClient.PlaylistSummary) {
        isBusy = true
        Task {
            defer { isBusy = false }
            do {
                try await api.deletePlaylist(id: p.id)
                await reloadPlaylists()
            } catch {
                statusText = "Lỗi xoá playlist: \(error.localizedDescription)"
            }
        }
    }
}
