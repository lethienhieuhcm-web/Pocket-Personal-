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
