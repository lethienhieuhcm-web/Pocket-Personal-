import SwiftUI

struct ContentView: View {
    @EnvironmentObject var auth: AuthManager
    @EnvironmentObject var engine: AudioEngine
    @State private var showFullPlayer = false

    var body: some View {
        Group {
            if auth.isLoggedIn {
                // 4.1: Tab bar theo UI thống nhất đã Chốt (Thư viện | Thư mục).
                // 4.7: thêm tab Cài đặt. 4.8: thêm tab Tìm kiếm.
                ZStack(alignment: .bottom) {
                    TabView {
                        LibraryView()
                            .tabItem {
                                Label("Thư viện", systemImage: "music.note.list")
                            }
                        FolderBrowserView()
                            .tabItem {
                                Label("Thư mục", systemImage: "folder")
                            }
                        SearchView()
                            .tabItem {
                                Label("Tìm kiếm", systemImage: "magnifyingglass")
                            }
                        SettingsView()
                            .tabItem {
                                Label("Cài đặt", systemImage: "gear")
                            }
                    }

                    // Mini player phía trên TabView
                    VStack {
                        Spacer()
                        MiniPlayer(showFullPlayer: $showFullPlayer)
                            .padding(.bottom, 60)
                    }
                }
                .fullScreenCover(isPresented: $showFullPlayer) {
                    PlayerView()
                }
            } else {
                AuthView()
            }
        }
    }
}

/// Thư viện nhạc — list từ Drive qua Worker, tìm kiếm offline, tap để phát.
struct LibraryView: View {
    @EnvironmentObject var auth: AuthManager
    @EnvironmentObject var driveAuth: DriveAuthManager
    @EnvironmentObject var api: MusicApiClient
    @EnvironmentObject var engine: AudioEngine

    @State private var searchText = ""
    @State private var errorText: String? = nil
    @State private var isLoading = false
    @State private var showPlayer = false
    @State private var showImport = false
    /// Redesign 80/20: 0=Bài hát, 1=Album, 2=Nghệ sĩ
    @State private var libraryTab = 0
    /// Đồng bộ thông minh: tự sync nếu cache cũ hơn 15 phút
    @State private var isSyncing = false
    @State private var lastSyncText = "" 

    private var visibleTracks: [Track] {
        searchText.isEmpty ? api.tracks : api.searchOffline(searchText)
    }

    /// Đồng bộ thông minh: tự sync ngầm nếu cache cũ hơn 15 phút
    private func smartSync(force: Bool) async {
        let lastSync = api.lastSync
        let stale = Date().timeIntervalSince1970 * 1000 - Double(lastSync) > 15 * 60 * 1000
        guard force || stale else { return }
        isSyncing = true
        await api.syncLibrary()
        isSyncing = false
        if api.lastSync > 0 {
            let mins = Int((Date().timeIntervalSince1970 * 1000 - Double(api.lastSync)) / 60000)
            lastSyncText = mins < 1 ? "vừa xong" : "\(mins) phút trước"
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if !driveAuth.isConnected {
                    VStack(spacing: 12) {
                        Text("Chưa kết nối Google Drive")
                            .font(.title3)
                            .bold()
                        Text("Đăng nhập Google để lấy nhạc từ Drive của bạn.")
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
                    .padding()
                } else if isLoading && api.tracks.isEmpty {
                    ProgressView("Đang tải danh sách nhạc…")
                } else {
                    Picker("", selection: $libraryTab) {
                        Text("Bài hát").tag(0)
                        Text("Album").tag(1)
                        Text("Nghệ sĩ").tag(2)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal)
                    if libraryTab == 0 {
                    List(visibleTracks) { track in
                        Button {
                            Task {
                                // 4.5: phát + prefetch queue gapless
                                await engine.playWithQueue(track, from: Array(visibleTracks), via: api)
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
                            }
                        }
                    }
                    .searchable(text: $searchText, prompt: "Tìm theo tên bài")
                    .refreshable {
                        await reload(force: true)
                    }
                    } else if libraryTab == 1 {
                        AlbumListView(tracks: api.tracks, onSelect: { track, all in
                            Task {
                                await engine.playWithQueue(track, from: all, via: api)
                                showPlayer = true
                            }
                        })
                    } else {
                        ArtistListView(tracks: api.tracks, onSelect: { track, all in
                            Task {
                                await engine.playWithQueue(track, from: all, via: api)
                                showPlayer = true
                            }
                        })
                    }
                }
            }
            .navigationTitle("Thư viện nhạc")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Nhập từ link") {
                        showImport = true
                    }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Đăng xuất") {
                        Task { await auth.logout() }
                    }
                }
            }
            // 4.8: push full-page thay vì .sheet (cấm modal/popup).
            .navigationDestination(isPresented: $showPlayer) {
                PlayerView()
            }
            .navigationDestination(isPresented: $showImport) {
                ImportView()
            }
            .task {
                await reload()
            }
        }
    }

    private func reload(force: Bool = false) async {
        guard driveAuth.isConnected else { return }
        errorText = nil
        isLoading = true
        defer { isLoading = false }
        do {
            try await api.listLibrary(forceRefresh: force)
        } catch MusicError.driveTokenInvalid {
            // Drive token sai/hết hạn → về trạng thái "chưa kết nối",
            // user kết nối lại thay vì bị báo nhầm "hết phiên đăng nhập".
            driveAuth.clear()
        } catch MusicError.message(let msg) {
            errorText = msg
        } catch {
            errorText = "Lỗi mạng. Kiểm tra kết nối và thử lại."
        }
    }

    private func formatSize(_ bytes: Int64) -> String {
        let mb = Double(bytes) / 1_048_576
        if mb >= 1 { return String(format: "%.1f MB", mb) }
        return String(format: "%d KB", max(bytes / 1024, 1))
    }
}


/// Redesign 80/20: list Album nhóm từ tracks
struct AlbumListView: View {
    let tracks: [Track]
    let onSelect: (Track, [Track]) -> Void
    @State private var selectedAlbum: String? = nil

    private var grouped: [(name: String, tracks: [Track])] {
        let g = Dictionary(grouping: tracks) { $0.album.isEmpty ? "(Chưa rõ album)" : $0.album }
        return g.map { (name: $0.key, tracks: $0.value) }.sorted { $0.name < $1.name }
    }

    var body: some View {
        if let album = selectedAlbum,
           let group = grouped.first(where: { $0.name == album }) {
            List(group.tracks) { track in
                Button {
                    onSelect(track, group.tracks)
                } label: {
                    HStack(spacing: 12) {
                        TrackArtworkView(track: track)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(track.displayTitle).lineLimit(1)
                            Text(track.album).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle(album)
            .navigationBarTitleDisplayMode(.inline)
        } else {
            List(grouped, id: \.name) { group in
                Button {
                    selectedAlbum = group.name
                } label: {
                    HStack(spacing: 12) {
                        Text("💿").font(.title2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(group.name).lineLimit(1)
                            Text("\(group.tracks.count) bài")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

/// Redesign 80/20: list Nghệ sĩ nhóm từ tracks
struct ArtistListView: View {
    let tracks: [Track]
    let onSelect: (Track, [Track]) -> Void
    @State private var selectedArtist: String? = nil

    private var grouped: [(name: String, tracks: [Track])] {
        let g = Dictionary(grouping: tracks) { $0.artist.isEmpty ? "(Chưa rõ nghệ sĩ)" : $0.artist }
        return g.map { (name: $0.key, tracks: $0.value) }.sorted { $0.name < $1.name }
    }

    var body: some View {
        if let artist = selectedArtist,
           let group = grouped.first(where: { $0.name == artist }) {
            List(group.tracks) { track in
                Button {
                    onSelect(track, group.tracks)
                } label: {
                    HStack(spacing: 12) {
                        TrackArtworkView(track: track)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(track.displayTitle).lineLimit(1)
                            Text(track.artist).font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .navigationTitle(artist)
            .navigationBarTitleDisplayMode(.inline)
        } else {
            List(grouped, id: \.name) { group in
                Button {
                    selectedArtist = group.name
                } label: {
                    HStack(spacing: 12) {
                        Text("👤").font(.title2)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(group.name).lineLimit(1)
                            Text("\(group.tracks.count) bài")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AuthManager())
}
