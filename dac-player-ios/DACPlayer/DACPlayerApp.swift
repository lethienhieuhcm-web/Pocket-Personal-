import SwiftUI

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
        let tokenClosure: () -> String? = { [weak d] in d?.token() }
        let client = MusicApiClient(auth: a, driveToken: tokenClosure)
        _api = StateObject(wrappedValue: client)
        _copyManager = StateObject(wrappedValue: DriveCopyManager(auth: a, driveToken: tokenClosure))
        _art = StateObject(wrappedValue: CoverArtManager(api: client))
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
        }
    }
}
