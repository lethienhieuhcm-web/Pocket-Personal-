import SwiftUI

struct ContentView: View {
    @EnvironmentObject var auth: AuthManager

    var body: some View {
        Group {
            if auth.isLoggedIn {
                LibraryView()
            } else {
                AuthView()
            }
        }
    }
}

/// Placeholder thư viện nhạc — bước 3.3 sẽ thay bằng list thật.
struct LibraryView: View {
    @EnvironmentObject var auth: AuthManager

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("Thư viện nhạc")
                    .font(.largeTitle)
                    .bold()
                if let email = auth.email {
                    Text(email)
                        .foregroundStyle(.secondary)
                }
                Text("Bước 3.3: list nhạc từ Drive")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                Spacer()
            }
            .padding()
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Đăng xuất") {
                        Task { await auth.logout() }
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
