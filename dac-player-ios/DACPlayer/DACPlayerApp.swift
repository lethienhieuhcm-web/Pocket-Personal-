import SwiftUI

@main
struct DACPlayerApp: App {
    @StateObject private var auth: AuthManager
    @StateObject private var driveAuth: DriveAuthManager
    @StateObject private var engine: AudioEngine
    @StateObject private var api: MusicApiClient

    @MainActor
    init() {
        let a = AuthManager()
        let d = DriveAuthManager()
        _auth = StateObject(wrappedValue: a)
        _driveAuth = StateObject(wrappedValue: d)
        _engine = StateObject(wrappedValue: AudioEngine())
        _api = StateObject(wrappedValue: MusicApiClient(auth: a, driveToken: { [weak d] in d?.token() }))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
                .environmentObject(driveAuth)
                .environmentObject(engine)
                .environmentObject(api)
        }
    }
}
