import SwiftUI
import SwiftData
import GoogleSignIn

@main
struct DACPlayerApp: App {
    @StateObject private var auth: AuthManager
    @StateObject private var driveAuth: DriveAuthManager
    @StateObject private var engine: AudioEngine
    @StateObject private var api: MusicApiClient
    @StateObject private var copyManager: DriveCopyManager
    @StateObject private var art: CoverArtManager

    @MainActor
    init() {
        let a = AuthManager()
        let d = DriveAuthManager()
        _auth = StateObject(wrappedValue: a)
        _driveAuth = StateObject(wrappedValue: d)
        _engine = StateObject(wrappedValue: AudioEngine())
        // v3.0: server tự quản Drive token (D1 + auto-refresh), client không cần gửi nữa.
        let tokenClosure: () -> String? = { nil }
        let client = MusicApiClient(auth: a, driveToken: tokenClosure)
        _api = StateObject(wrappedValue: client)
        _copyManager = StateObject(wrappedValue: DriveCopyManager(auth: a, driveToken: tokenClosure))
        _art = StateObject(wrappedValue: CoverArtManager(api: client))
        // v3.0: đăng ký background sync
        DriveSyncScheduler.register(api: client)
        DriveSyncScheduler.scheduleNext()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
                .environmentObject(driveAuth)
                .environmentObject(engine)
                .environmentObject(api)
                .environmentObject(copyManager)
                .environmentObject(art)
                .onOpenURL { url in
                    GIDSignIn.sharedInstance.handle(url)
                }
        }
        .modelContainer(for: [CachedFolder.self])
    }
}
