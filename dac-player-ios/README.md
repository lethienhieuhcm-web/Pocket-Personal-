# DAC Pocket — iOS (Swift, Native)

App nhạc bit-perfect cho iOS, dùng chung Worker API với bản Android
(`dac-player/`). Native Swift + SwiftUI, DAC qua AVAudioSession.

## Cấu trúc

```
dac-player-ios/
├── DACPlayer.xcodeproj/      Xcode project (viết tay, minimal)
├── DACPlayer/
│   ├── DACPlayerApp.swift    Entry point
│   ├── ContentView.swift     Màn hình chính
│   └── Assets.xcassets/      Icon + màu
└── README.md
```

## Build

- CI: `.github/workflows/build-dac-ios.yml` — chạy trên `macos-latest`,
  build unsigned cho iOS Simulator (`CODE_SIGNING_ALLOWED=NO`), đóng gói
  IPA unsigned làm artifact.
- Local: mở `DACPlayer.xcodeproj` bằng Xcode, chọn scheme DACPlayer, Run.

## Lộ trình (theo dac-app-plan.md Phase 3)

- 3.1 ✅ Project + CI build (hiện tại)
- 3.2 Auth: AuthManager.swift, Keychain, Google Sign-In SDK, AuthView
- 3.3 Music Library + Player: MusicApiClient, LibraryView, PlayerView
- 3.4 DAC via AVAudioSession (preferredSampleRate, volume 100%)
- 3.5 Libraries iOS: Kingfisher, URLSession, Codable, AVFoundation
- 3.6 Copy + Email: DriveCopyManager.swift, UI Import
- 3.7 Test bug + Deploy (TestFlight / sideload)
