import SwiftUI

struct ContentView: View {
    @EnvironmentObject var auth: AuthManager

    var body: some View {
        Group {
            if auth.isLoggedIn {
                // 4.1: Tab bar theo UI thống nhất đã Chốt (Thư viện | Thư mục).
                // Tab Tìm kiếm + Cài đặt thêm ở bước sau theo roadmap.
                TabView {
                    LibraryView()
                        .tabItem {
                            Label("Thư viện", systemImage: "music.note.list")
                        }
                    FolderBrowserView()
                        .tabItem {
                            Label("Thư mục", systemImage: "folder")
                        }
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

    private var visibleTracks: [Track] {
        searchText.isEmpty ? api.tracks : api.searchOffline(searchText)
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
                    List(visibleTracks) { track in
                        Button {
                            Task {
                                await engine.play(track, via: api)
                                showPlayer = true
                            }
                        } label: {
                            HStack(spacing: 12) {
                                TrackArtworkView(track: track)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(track.title)
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
            .sheet(isPresented: $showPlayer) {
                PlayerView()
            }
            .sheet(isPresented: $showImport) {
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
            try await api.listMusic(forceRefresh: force)
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

#Preview {
    ContentView()
        .environmentObject(AuthManager())
}
