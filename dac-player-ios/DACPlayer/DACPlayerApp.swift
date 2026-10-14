import SwiftUI

@main
struct DACPlayerApp: App {
    @StateObject private var auth: AuthManager
    @StateObject private var driveAuth: DriveAuthManager
    @StateObject private var engine: AudioEngine
    @StateObject private var api: MusicApiClient
    @StateObject private var copyManager: DriveCopyManager

    @MainActor
    init() {
        let a = AuthManager()
        let d = DriveAuthManager()
        _auth = StateObject(wrappedValue: a)
        _driveAuth = StateObject(wrappedValue: d)
        _engine = StateObject(wrappedValue: AudioEngine())
        let tokenClosure: () -> String? = { [weak d] in d?.token() }
        _api = StateObject(wrappedValue: MusicApiClient(auth: a, driveToken: tokenClosure))
        _copyManager = StateObject(wrappedValue: DriveCopyManager(auth: a, driveToken: tokenClosure))
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(auth)
                .environmentObject(driveAuth)
                .environmentObject(engine)
                .environmentObject(api)
                .environmentObject(copyManager)
        }
    }
}
