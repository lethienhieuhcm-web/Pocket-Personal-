# Plan "dac-app" — APK nhạc như Spotify, Native Android + iOS

**Chốt:** 2026-10-13
**Trạng thái:** Phase 3 — HOÀN TẤT trong phạm vi tự kiểm chứng (2026-10-14, CI build pass + API contract test). Chi tiết: `dac-player/docs/phase3-ios.md`
**Quyết định:** Native cho cả Android (Kotlin) và iOS (Swift) — Không Flutter, không React Native, không KMP

---

## 1. Mục tiêu

App nhạc Native cho Android và iOS, mở app → đăng ký/đăng nhập ngay trong app → nghe nhạc bit-perfect qua USB DAC từ Google Drive của chính user. Không cần mở web Pocket Personal.

**Điểm khác biệt so với app khác:**
- Bit-perfect USB DAC + Google Drive streaming + Account + Copy từ folder share — không app nào có đủ 5 thứ
- Native tối ưu từng platform (không cross-platform framework)
- 0đ cho Android (APK qua web), $99/năm cho iOS (App Store)
- Thương mại được (license sạch sau khi fix FFmpeg)

---

## 2. Quyết định kiến trúc: Native

### 2.1 Tại sao Native?

**Học từ ông lớn:**

| Công ty | Chọn gì | Lý do | Bài học |
|---------|---------|-------|---------|
| **Spotify** | Native | Music playback cần tối ưu, background tasks phức tạp | dac-app cũng cần tối ưu playback |
| **Shopify** | Native (bỏ RN 2026) | AI làm viết 2 lần rẻ hơn, cần performance (cold start -50%, APK -109MB) | Đừng sợ viết 2 lần nếu DAC quan trọng |
| **Apple Music** | Native | Tối ưu cho Apple devices, dùng CoreAudio exclusive | DAC cần native API từng platform |
| **Airbnb** | Native (bỏ RN 2018) | RN không đáp ứng performance | Cross-platform không phải lúc nào cũng thắng |
| **Netflix** | KMP (share logic, UI native) | Logic share, UI native | dac-app: logic share qua API, UI native |

**Pattern chung:** Công ty nào có phần **performance-critical** (playback, DAC, camera, AR) đều chọn **Native**. Công ty nào UI đơn giản, content-light thì chọn Flutter/RN.

dac-app có phần performance-critical (DAC bit-perfect) → **Native**.

### 2.2 Tại sao không Flutter / React Native / KMP?

| Framework | Vấn đề với dac-app |
|-----------|-------------------|
| **Flutter** | Phải viết lại Android từ đầu bằng Dart (vứt code Kotlin hiện tại). App size +96% (12MB vs 6MB). Memory 3x. Vẫn phải viết DAC native 2 platform qua Platform Channel. |
| **React Native** | Phải viết lại Android từ đầu bằng JS (vứt code Kotlin). FPS 42 khi scroll list dài (giật lag). Battery 15%/giờ (tệ nhất). Shopify vừa bỏ. |
| **KMP** | Share logic được, nhưng DAC + UI vẫn phải native. Thêm complexity setup. iOS UI vẫn cần Swift dev. Lợi ích không đủ lớn để đổi lấy complexity khi team nhỏ. |

**Điểm mấu chốt:** DAC không share được dù dùng framework nào.

```
dac-app — Phân bổ công sức:
├── DAC + Audio Engine: ~50% (KHÔNG share được)
│   ├── Android: decent-player + USB driver (Kotlin/Java)
│   └── iOS: AVAudioSession + AVFoundation (Swift)
│       → Hoàn toàn khác nhau, không framework nào giúp
│
├── UI: ~20% (Share được, nhưng UI dac-app đơn giản)
│   └── List nhạc + Player + Auth screen
│
└── Business Logic: ~30% (Share được qua API)
    ├── Auth (register/login/logout)
    ├── Drive API (list, stream, copy)
    └── JSON parsing, validation
```

Cross-platform framework chỉ giúp share 50% (UI + Logic). 50% còn lại (DAC) vẫn phải viết native riêng. Lợi ích bị giảm một nửa, nhưng phải trả giá bằng app size, memory, và viết lại Android.

**Quyết định:** Native cho cả 2 platform. Viết riêng từng platform, tối ưu từng platform, không compromise.

### 2.3 Nguyên tắc kiến trúc

**Backend dùng chung, App viết riêng.**

```
                    ┌──────────────────────────────┐
                    │ Worker (Pocket Personal)     │
                    │ — DÙNG CHUNG cho cả 2 app    │
                    │                              │
                    │  /api/auth/* (register/login) │
                    │  /api/dac/* (music/stream)    │
                    │  D1 + Resend                 │
                    └──────────┬─────────┬─────────┘
                               │         │
                    ┌──────────▼──┐   ┌──▼──────────┐
                    │ Android App │   │ iOS App     │
                    │ (Kotlin)    │   │ (Swift)     │
                    │             │   │             │
                    │ Native UI   │   │ Native UI   │
                    │ decent-     │   │ AVAudio-    │
                    │ player DAC  │   │ Session DAC │
                    └─────────────┘   └─────────────┘
```

**API dùng chung:** Cả Android và iOS gọi cùng Worker endpoints, cùng format JSON. Logic auth giống nhau, nhưng code viết riêng bằng ngôn ngữ từng platform.

**Tài khoản là một:** User đăng ký qua Android → đăng nhập iOS được luôn (cùng tài khoản Pocket Personal). Và ngược lại.

**Worker là gate duy nhất:** Mọi request DAC đều phải có session token hợp lệ. Không có session → 401. Không bypass được bằng cách decompile app.

---

## 3. Kiến trúc tổng thể

### 3.1 Kiến trúc hệ thống

```
┌──────────────────────────────────────────────────────────────┐
│ Android App (Kotlin — Native)                                │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Auth Screen  │  │ Music Library│  │ DAC Player       │   │
│  │ - Đăng ký    │  │ - List nhạc  │  │ - USB DAC        │   │
│  │ - Đăng nhập  │  │ - Tìm kiếm   │  │ - Bit-perfect    │   │
│  │ - Đăng xuất  │  │ - Import     │  │ - Play/Pause/Seek│   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│                                                               │
│  Lưu local: EncryptedSharedPreferences                        │
│  - Session token (Pocket Personal)                            │
│  - Drive token (Google, AccountManager)                       │
└──────────────────┬───────────────────────────────────────────┘
                   │ HTTPS
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ Worker (Pocket Personal Backend — Cloudflare)                 │
│ — DÙNG CHUNG cho Android + iOS                               │
│                                                               │
│  Auth:                                                        │
│  /api/auth/register → Tạo user (D1) + gửi email verify       │
│  /api/auth/login    → Verify + tạo session (D1)               │
│  /api/auth/logout   → Xoá session                             │
│  /api/auth/verify   → Xác nhận email (link từ Resend)         │
│  /api/auth/sessions → List sessions của user                  │
│                                                               │
│  DAC (dac-pass):                                              │
│  /api/dac/music     → Verify session → Drive API → list      │
│  /api/dac/stream    → Verify session → Drive API → stream URL │
│                                                               │
│  KHÔNG lưu Drive token                                        │
└──────────────────┬───────────────────────────────────────────┘
                   │ HTTPS
                   ▼
┌──────────────────────────────────────────────────────────────┐
│ iOS App (Swift — Native)                                      │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ Auth Screen  │  │ Music Library│  │ DAC Player       │   │
│  │ - Đăng ký    │  │ - List nhạc  │  │ - USB DAC        │   │
│  │ - Đăng nhập  │  │ - Tìm kiếm   │  │ - Bit-perfect*   │   │
│  │ - Đăng xuất  │  │ - Import     │  │ - Play/Pause/Seek│   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│                                                               │
│  Lưu local: Keychain                                          │
│  - Session token (Pocket Personal)                            │
│  - Drive token (Google Sign-In SDK)                           │
└──────────────────────────────────────────────────────────────┘

* iOS: Gần bit-perfect (không có true bypass như Android, nhưng iOS không
  resample như Android nên vẫn đạt gần bit-perfect nếu làm đúng)
```

### 3.2 Kiến trúc Android (chi tiết)

```
Android App (Kotlin)
├── UI Layer (Views/XML hoặc Jetpack Compose)
│   ├── AuthActivity — Đăng ký/Đăng nhập/Đăng xuất
│   ├── MainActivity — Music Library + Player
│   └── SettingsActivity — About + Licenses
│
├── Data Layer
│   ├── AuthManager — Gọi /api/auth/*, lưu token (EncryptedSharedPreferences)
│   ├── DriveAuthManager — Google AccountManager, lấy Drive token
│   ├── MusicApiClient — Gọi /api/dac/*, cache list 24h
│   └── DriveCopyManager — Gọi Drive API copy (trực tiếp, không qua Worker)
│
└── Audio Layer
    ├── decent-player (MIT) — USB DAC driver
    ├── Media3 (ExoPlayer) — Playback framework
    ├── FFmpeg LGPL — Decoders (APE, ALAC, etc.)
    └── libFLAC — FLAC decoder
```

### 3.3 Kiến trúc iOS (chi tiết)

```
iOS App (Swift)
├── UI Layer (SwiftUI)
│   ├── AuthView — Đăng ký/Đăng nhập/Đăng xuất
│   ├── LibraryView — Music Library + Player
│   └── SettingsView — About + Licenses
│
├── Data Layer
│   ├── AuthManager — Gọi /api/auth/*, lưu token (Keychain)
│   ├── DriveAuthManager — Google Sign-In SDK, lấy Drive token
│   ├── MusicApiClient — Gọi /api/dac/*, cache list 24h
│   └── DriveCopyManager — Gọi Drive API copy (trực tiếp, không qua Worker)
│
└── Audio Layer
    ├── AVAudioSession — Audio session, set sample rate
    ├── AVFoundation (AVPlayer) — Playback framework
    ├── FFmpeg LGPL — Decoders (via AudioToolbox hoặc custom)
    └── CoreAudio — DAC output (không có Hog Mode trên iOS)
```

### 3.4 So sánh Android vs iOS

| Hạng mục | Android (Kotlin) | iOS (Swift) |
|----------|-----------------|-------------|
| **Ngôn ngữ** | Kotlin | Swift |
| **UI** | Views/XML hoặc Jetpack Compose | SwiftUI |
| **DAC** | decent-player (USB driver riêng) | AVAudioSession + AVFoundation |
| **Bypass mixer** | ✅ Có (USB driver bypass) | ❌ Không có (iOS không cho bypass) |
| **Bit-perfect** | ✅ Đảm bảo (bypass) | ⚠️ Gần đúng (iOS không resample) |
| **Token storage** | EncryptedSharedPreferences | Keychain |
| **Drive auth** | AccountManager | Google Sign-In SDK |
| **Build** | GitHub Actions (Linux runner) | GitHub Actions (macOS runner) |
| **Phân phối** | APK qua web (0đ) | TestFlight/App Store ($99/năm) |
| **Auth API** | ✅ Dùng chung Worker | ✅ Dùng chung Worker |
| **Drive API** | ✅ Dùng chung | ✅ Dùng chung |
| **Copy logic** | ✅ Dùng chung API | ✅ Dùng chung API |

---

## 4. Lộ trình từng bước

### Phase 0 — Chuẩn bị (trước khi code)

**Mục tiêu:** Dọn dẹp, chuẩn bị nền tảng, không code tính năng mới.

| Bước | Việc | 8b |
|------|------|-----|
| 0.1 | Đọc `RULES.md` mục 8b + `CHECKLIST.md` + skill `english-lab-fix` | ✅ Bắt buộc |
| 0.2 | Kiểm tra code Android hiện tại (đã có gì, thiếu gì) | ✅ Đọc code trước |
| 0.3 | Kiểm tra Worker API (auth + dac-pass đã live chưa) | ✅ Verify bằng request thật |
| 0.4 | Tạo file `THIRD_PARTY_NOTICES.md` (template, điền dần) | ✅ Chuẩn bị trước |

**Kết quả:** Hiểu rõ trạng thái hiện tại, không code mù.

---

### Phase 1 — Android: Auth + Bảo mật + FFmpeg LGPL + Libraries

**Mục tiêu:** Android app hoàn chỉnh về auth, bảo mật, license sạch.

#### Bước 1.1 — Worker: Rate limiting + Timing equalization

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Rate limiting login | 5 lần/15 phút/IP+email, khóa 15 phút sau 5 lần sai | Spotify |
| Rate limiting register | 5 đăng ký/IP/giờ | Spotify |
| Timing equalization | Luôn chạy PBKDF2 dù user không tồn tại (chống đoán email qua timing) | Spotify |

**Test:** Tạo session test, gọi login sai 5 lần → lần 6 bị khóa. Verify bằng curl.

#### Bước 1.2 — Android: EncryptedSharedPreferences

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Chuyển token sang EncryptedSharedPreferences | AES-256-GCM, key trong Android Keystore | Spotify (EncryptedSharedPreferences) |
| Migrate token cũ | Đọc token từ SharedPreferences cũ → ghi vào Encrypted → xoá cũ | — |

**Test:** Đăng nhập → kiểm tra token lưu trong EncryptedSharedPreferences (không đọc được bằng plain text).

#### Bước 1.3 — Android: Auth UI (Đăng ký / Đăng nhập / Đăng xuất)

| Việc | Chi tiết |
|------|----------|
| Auth Screen riêng | Tách khỏi MainActivity, không trộn với player |
| Đăng ký | Email + mật khẩu → `POST /api/auth/register` → auto-login |
| Đăng nhập | Email + mật khẩu → `POST /api/auth/login` → vào thư viện |
| Đăng xuất | `POST /api/auth/logout` + xoá token local → về Auth Screen |
| Validation | Email hợp lệ, mật khẩu min 8 ký tự, hiện lỗi rõ ràng |

**Test:** Đăng ký user mới → đăng nhập → đăng xuất → đăng nhập lại. Verify bằng browser + curl.

#### Bước 1.4 — Android: Libraries Phase 1

| Library | Dùng cho | License | Học từ |
|---------|----------|---------|--------|
| **Coil** | Load ảnh bìa album từ URL/file, cache tự động | Apache 2.0 | Spotify, app Android chuẩn |
| **OkHttp** | Networking — thay HttpURLConnection. Retry, timeout, connection pool | Apache 2.0 | Spotify, hầu hết app Android |
| **kotlinx.serialization** | Parse JSON từ Worker/Drive API — thay parse tay | Apache 2.0 | Spotify, app Kotlin chuẩn |
| **MediaMetadataRetriever** | Đọc metadata từ file (tên bài, artist, album, ảnh bìa, duration) | Android SDK | Mọi app nhạc |

**Test:** Load list nhạc → ảnh bìa hiện đúng. Parse JSON không lỗi. Đọc metadata từ FLAC đúng.

#### Bước 1.5 — Android: FFmpeg LGPL (thay Jellyfin GPL)

| Việc | Chi tiết |
|------|----------|
| Build FFmpeg LGPL AAR | GitHub Actions workflow, Media3 1.9.3 + FFmpeg release/6.0, không `--enable-gpl` |
| Thay Jellyfin GPL | Xoá `implementation(libs.media3.ffmpeg.decoder)` → thêm `implementation(files("libs/media3-ffmpeg-lgpl.aar"))` |
| Thêm THIRD_PARTY_NOTICES.md | Ghi FFmpeg LGPL v2.1+ + link source + commit hash |
| Thêm Settings → About → Licenses | Hiển thị THIRD_PARTY_NOTICES.md trong app |

**Test:** Build APK → verify DEX không chứa Jellyfin → verify FFmpeg LGPL hoạt động (phát APE, ALAC) → deploy `/dac`.

#### Bước 1.6 — Test bug + Deploy

| Việc | Chi tiết | 8b |
|------|----------|-----|
| Test bug frontend + backend | Đăng ký, đăng nhập, đăng xuất, list nhạc, phát nhạc | ✅ Test bug đồng thời |
| Build APK | GitHub Actions, tăng versionCode/versionName | ✅ Mỗi build tăng version |
| Verify APK | SHA256 + grep DEX strings (X-Drive-Token, versionText) | ✅ Không tin "DEPLOY OK" |
| Deploy `/dac` | Cập nhật APK + version + SHA256 + link GitHub run | ✅ User verify được |
| Dọn data test | Xoá user/session test | ✅ Dọn sạch |

**Kết quả Phase 1:** Android app hoàn chỉnh: auth + bảo mật + license sạch + libraries chuẩn. Deploy lên `/dac`.

---

### Phase 2 — Android: Copy + Email + Libraries

**Mục tiêu:** Thêm tính năng Copy từ Drive share + Email verification.

#### Bước 2.1 — Android: Copy từ Drive share

| Việc | Chi tiết |
|------|----------|
| UI Import | Paste link → List nội dung → Chọn file/folder → Copy → Progress |
| Drive API copy | `GET /drive/v3/files` (list), `POST /drive/v3/files/{id}/copy` (copy), `POST /drive/v3/files` (tạo folder) |
| Đệ quy folder | List folder → tạo folder đích → copy từng file → đệ quy subfolder |
| Progress | Hiển thị x/y file, dung lượng đã copy |
| Fallback | Nếu copy bị chặn → tạo shortcut hoặc download+upload |
| Giới hạn | Chỉ copy file audio, giới hạn dung lượng/ngày, log lại |

**Test:** Paste link folder share (10 file FLAC) → copy → verify file trong Drive user → nghe được qua app.

**Lưu ý scope:** Test `drive.readonly` + `drive.file` có đủ copy không. Nếu không → xin scope `drive` full + cảnh báo user rõ.

#### Bước 2.2 — Worker: Email verification (Resend)

| Việc | Chi tiết |
|------|----------|
| Verify domain | `lethanhdong.one` trên Resend (DNS: SPF, DKIM, DMARC) |
| Gửi email verify | Đăng ký → Worker tạo user chưa verify → gửi email link → user bấm link → Worker đánh dấu verified |
| Quên mật khẩu | Gửi email reset qua Resend → user bấm link → đặt mật khẩu mới |
| Resend free tier | 3,000 emails/tháng, 100/ngày — đủ cho giai đoạn đầu |

**Test:** Đăng ký user mới → nhận email → bấm link → verify thành công → đăng nhập được.

#### Bước 2.3 — Android: Libraries Phase 2

| Library | Dùng cho | License | Học từ |
|---------|----------|---------|--------|
| **Room** | Cache thư viện nhạc (thay SharedPreferences JSON). Query nhanh, type-safe | Apache 2.0 | Spotify, app Android chuẩn |
| **Hilt** | Dependency injection — quản lý dependencies khi app lớn lên | Apache 2.0 | Spotify, Google |
| **WorkManager** | Background tasks: sync thư viện, download, copy nhạc | Apache 2.0 | Google, nhiều app |
| **jaudiotagger** | Đọc/ghi metadata tags (ID3, Vorbis comment) — edit metadata | Apache 2.0 | Nhiều app nhạc |

**Test:** Cache thư viện bằng Room → query nhanh. Copy nhạc chạy background bằng WorkManager.

#### Bước 2.4 — Test bug + Deploy

| Việc | Chi tiết |
|------|----------|
| Test bug Copy + Email | Copy folder, verify email, quên mật khẩu |
| Build APK + Deploy `/dac` | Tăng version, verify SHA256 + DEX, deploy |

**Kết quả Phase 2:** Android app có Copy + Email verification + Libraries Phase 2.

---

### Phase 3 — iOS: Native Swift App

**Mục tiêu:** iOS app Native, dùng chung Worker API với Android, DAC qua AVAudioSession.

#### Bước 3.1 — Chuẩn bị iOS

| Việc | Chi tiết |
|------|----------|
| Tạo Xcode project | Swift + SwiftUI, Bundle ID `one.lethanhdong.dacapp` |
| GitHub Actions workflow | macOS runner, build IPA, upload artifact |
| Apple Developer Program | Đăng ký $99/năm (khi nào sẵn sàng phân phối) |
| TestFlight setup | Tạo app record trong App Store Connect |

**Lưu ý:** Có thể build IPA không cần $99 (dùng free Apple ID, app hết hạn 7 ngày). $99 chỉ cần khi muốn TestFlight/App Store.

#### Bước 3.2 — iOS: Auth (viết riêng bằng Swift)

| Việc | Chi tiết |
|------|----------|
| AuthManager.swift | Gọi `/api/auth/*` (giống Android, nhưng viết bằng Swift) |
| Token storage | Keychain (iOS) — thay EncryptedSharedPreferences (Android) |
| Drive auth | Google Sign-In SDK (iOS) — thay AccountManager (Android) |
| Auth UI | SwiftUI: AuthView (Đăng ký/Đăng nhập/Đăng xuất) |

**Code Swift dịch từ Kotlin:**

```swift
// Swift (iOS) — dịch từ Kotlin (Android)
func login(email: String, password: String) async -> Result {
    let response = await http.post("/api/auth/login", ["email": email, "password": password])
    if response.ok {
        saveToken(response.token) // Keychain
        return .success
    }
    return .error(response.message)
}
```

**Test:** Đăng ký user mới trên iOS → đăng nhập → đăng xuất. Verify bằng curl (cùng Worker API).

#### Bước 3.3 — iOS: Music Library + Player

| Việc | Chi tiết |
|------|----------|
| MusicApiClient.swift | Gọi `/api/dac/*` (giống Android, viết bằng Swift) |
| LibraryView (SwiftUI) | List nhạc, tìm kiếm, cache 24h |
| PlayerView (SwiftUI) | Play/Pause/Seek, hiển thị metadata |

**Test:** List nhạc → phát nhạc → seek → verify âm thanh.

#### Bước 3.4 — iOS: DAC via AVAudioSession

| Việc | Chi tiết |
|------|----------|
| AVAudioSession | Category `.playback`, set `preferredSampleRate` = sample rate file |
| AVPlayer | Playback framework (thay Media3 trên Android) |
| Volume = 100% | Không attenuate, không EQ, không processing |
| Verify sample rate | DAC báo đúng sample rate (vd: 96kHz file → DAC hiện 96kHz) |

**Lưu ý:** iOS không có true bypass như Android. Nhưng iOS không resample như Android, nên nếu set đúng sample rate + volume 100% + không processing → đạt gần bit-perfect.

**Test:** Phát FLAC 96kHz → DAC báo 96kHz. Phát FLAC 44.1kHz → DAC báo 44.1kHz.

#### Bước 3.5 — iOS: Libraries Phase 1 (iOS)

| Library | Dùng cho | License | Học từ |
|---------|----------|---------|--------|
| **Kingfisher** | Load ảnh bìa (tương đương Coil trên Android) | MIT | App iOS chuẩn |
| **URLSession** | Networking (built-in iOS, tương đương OkHttp) | Apple | iOS chuẩn |
| **Codable** | Parse JSON (built-in Swift, tương đương kotlinx.serialization) | Apple | Swift chuẩn |
| **AVFoundation** | Đọc metadata (tương đương MediaMetadataRetriever) | Apple | iOS chuẩn |

**Lưu ý:** iOS dùng nhiều built-in (URLSession, Codable, AVFoundation) thay vì third-party libraries như Android. Ít dependency hơn.

#### Bước 3.6 — iOS: Copy + Email

| Việc | Chi tiết |
|------|----------|
| DriveCopyManager.swift | Gọi Drive API copy (giống Android, viết bằng Swift) |
| UI Import (SwiftUI) | Paste link → List → Chọn → Copy → Progress |
| Email verification | Dùng chung Worker API (đã có từ Phase 2) |

**Test:** Copy folder trên iOS → verify file trong Drive → nghe được.

#### Bước 3.7 — Test bug + Deploy

| Việc | Chi tiết |
|------|----------|
| Test bug iOS | Auth, list nhạc, phát nhạc, copy, DAC sample rate |
| Build IPA | GitHub Actions (macOS runner), tăng version |
| Deploy | TestFlight (nếu có $99) hoặc AltStore/Sideloadly (free Apple ID) |

**Kết quả Phase 3:** iOS app Native hoàn chỉnh, dùng chung Worker với Android.

---

### Phase 4 — Hoàn thiện (cả 2 platform)

**Mục tiêu:** Tính năng nâng cao, polish, chuẩn bị launch.
**Nguyên tắc sắp xếp (học từ ông lớn, chốt 2026-10-14):** table stakes trước (cái nào cả 5 ông đều có thì mình phải có), rồi đến nền tảng tốc độ, rồi đến điểm khác biệt của Drive, rồi polish. Chi tiết nghiên cứu: artifact "DAC Player Competitive Research".

#### Bước 4.1 — Duyệt theo thư mục Drive (cả 2 platform) ✅ PASS 2026-10-14

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Folder tree | Duyệt nhạc theo cây thư mục Drive (thay vì list phẳng hiện tại) | UAPP "True folder playback" — cả 5 ông đều có |
| Worker API | Endpoint trả cây thư mục + breadcrumb | — |
| Vì sao trước | Tag nhạc hi-res lộn xộn, folder là nguồn đáng tin duy nhất | Nghiên cứu Q3 |

#### Bước 4.2 — D1 index + sync tăng dần (Worker)

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Index nhạc vào D1 | Lưu cây file + metadata cơ bản per user | Nền cho tìm kiếm nhanh |
| Incremental sync | Drive changes API (pageToken per user), lần đầu quét full, sau chỉ lấy thay đổi | Dropbox delta API (lý do UAPP/HiBy chọn Dropbox thay vì Drive) |
| Vì sao | List hàng nghìn file qua Drive API chậm (phân trang) — index làm folder browse nhanh | Khắc phục điểm yếu Drive #2 |

#### Bước 4.3 — Cache offline + retry/backoff (cả 2 platform)

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Cache bài đã nghe | Lưu file local (Room Android / FileManager iOS), LRU, giới hạn dung lượng do user đặt | Ông lớn không ai làm (không stream cloud) — đây là hào của mình |
| Retry + backoff | Dính 429/quota → backoff mũ, báo UI rõ ràng | Khắc phục điểm yếu Drive #3 |
| Chế độ offline | Hết mạng vẫn phát bài đã cache | — |

#### Bước 4.4 — Badge sample rate nguồn → DAC (cả 2 platform)

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Hiển thị 2 số | Format nguồn (VD 96kHz/24-bit) + tốc độ thực ra DAC | HiBy output-stats (long-press) — best-in-class |
| Chứng minh bit-perfect | User thấy DAC nhận đúng rate của file, không resample lén | Điểm yếu của UAPP ("best guess", bị Head-Fi chê) |

#### Bước 4.5 — Gapless playback (cả 2 platform)

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Android | Nếu decent-player hỗ trợ → bật gapless | Neutron "sample accurate" |
| iOS | AVQueuePlayer hoặc custom gapless logic | — |
| Nguyên tắc | 1 output stream liên tục, pre-decode bài tiếp ở boundary — KHÔNG crossfade | Onkyo chỉ có crossfade = điểm trừ |

#### Bước 4.6 — Access + Refresh token (cả 2 platform)

| Việc | Chi tiết | Học từ |
|------|----------|--------|
| Access token 1h + Refresh token 30d | Thay session 7 ngày hiện tại | Spotify |
| Rotation | Mỗi lần refresh → cấp refresh token mới, thu hồi cũ | Spotify |
| Refactor auth | Cần refactor cả Worker + Android + iOS | — |

**Lưu ý:** Cần refactor auth toàn hệ thống (web + Android + iOS). Làm sau khi tính năng phát nhạc ổn định.

#### Bước 4.7 — Session management UI (cả 2 platform)

| Việc | Chi tiết |
|------|----------|
| List sessions | Hiển thị danh sách thiết bị đang đăng nhập |
| Revoke từng session | User bấm → xoá session đó |
| Device fingerprint | Model + OS + IP + user agent |

#### Bước 4.8 — Tìm kiếm theo metadata (cả 2 platform) — HOÀN TẤT 2026-10-15

| Việc | Chi tiết | Trạng thái |
|------|----------|------------|
| Search by metadata | Tìm theo tên bài, artist, album (không chỉ tên file); FTS5 trên D1, gõ không dấu vẫn trúng | ✅ Worker live, test 13/13 pass |
| Index metadata | Dùng D1 index (4.2): cột artist/title/album/search_text + bảng FTS `dac_index_fts` + trigger đồng bộ; sync điền metadata lúc upsert | ✅ live |
| Fallback đúng | Có index nhưng 0 kết quả → `files:[]`, `total:0`; chỉ fallback Drive khi chưa từng sync | ✅ live test pass |
| Android | SearchActivity + phân trang + phát/prefetch | ⏳ CI |
| iOS | SearchView tab Tìm kiếm; PlayerView/ImportView chuyển từ `.sheet` sang `navigationDestination` (cấm modal) | ⏳ CI |

#### Bước 4.9 — Sleep timer + polish (cả 2 platform) ✅ HOÀN TẤT 15/10/2026

| Việc | Chi tiết | Trạng thái |
|------|----------|------------|
| Sleep timer | Hẹn giờ dừng phát (Tắt/15/30/60 phút, hết bài); panel inline, không popup | ✅ Worker n/a; Android CI 85/85; iOS CI pass |
| Queue | Màn hình Hàng chờ full-page: kéo-thả đổi thứ tự, vuốt xoá (không đụng bài đang phát) | ✅ Android + iOS |
| Playlist | API D1 (`GET/POST/DELETE /api/dac/playlists`, `GET/PUT /api/dac/playlists/{id}`) — lưu/mở/xoá, đồng bộ 2 máy; live test 12/12 | ✅ Worker + Android + iOS |

#### Bước 4.10 — Test E2E + Launch

| Việc | Chi tiết |
|------|----------|
| Test E2E với nhạc thật + DAC thật | Upload nhạc thật lên Drive, cài app, login, stream, cắm DAC |
| Test cả 2 platform | Android + iOS cùng test |
| Launch | Android: deploy `/dac`. iOS: TestFlight → App Store (nếu có $99) |

**Kết quả Phase 4:** Cả 2 app hoàn thiện, sẵn sàng launch.

---

## 5. Công nghệ

### 5.1 Android

| Hạng mục | Công nghệ |
|----------|-----------|
| **Ngôn ngữ** | Kotlin |
| **UI** | Views/XML (hiện tại) hoặc Jetpack Compose (màn hình mới) |
| **DAC** | decent-player (MIT), Media3 1.9.3, FFmpeg LGPL 6.0 |
| **Auth** | Pocket Personal Worker (Cloudflare), D1 |
| **Drive** | Google Drive API v3, AccountManager |
| **Email** | Resend API (free tier: 3,000/tháng, 100/ngày) |
| **Build** | GitHub Actions (Linux runner), Gradle 9.3.1, NDK 29 |
| **Deploy** | APK qua `lethanhdong.one/dac` (không Play Store) |

### 5.2 iOS

| Hạng mục | Công nghệ |
|----------|-----------|
| **Ngôn ngữ** | Swift |
| **UI** | SwiftUI |
| **DAC** | AVAudioSession, AVFoundation, CoreAudio |
| **Auth** | Pocket Personal Worker (Cloudflare), D1 (dùng chung với Android) |
| **Drive** | Google Drive API v3, Google Sign-In SDK |
| **Email** | Resend API (dùng chung với Android) |
| **Build** | GitHub Actions (macOS runner), Xcode 15+ |
| **Deploy** | TestFlight/App Store ($99/năm) hoặc AltStore/Sideloadly (free) |

### 5.3 Backend (dùng chung)

| Hạng mục | Công nghệ |
|----------|-----------|
| **Worker** | Cloudflare Workers (JavaScript) |
| **Database** | Cloudflare D1 (SQLite) |
| **Auth** | PBKDF2 + salt, session 7 ngày (sau này: access 1h + refresh 30d) |
| **Email** | Resend API |
| **Drive** | Google Drive API v3 (gọi từ Worker cho list/stream) |

---

## 6. Open Source Libraries — Từng giai đoạn

### 6.1 Android — Phase 1

| Library | Dùng cho | License | Học từ |
|---------|----------|---------|--------|
| **decent-player** | USB DAC driver | MIT | — |
| **Media3** | Playback framework (ExoPlayer) | Apache 2.0 | Google |
| **FFmpeg** | Decoders (APE, ALAC, etc.) | LGPL v2.1 | Spotify, Apple, VLC |
| **libFLAC** | FLAC decoder | BSD | Spotify, VLC |
| **AndroidX** | UI components | Apache 2.0 | Google |
| **Kotlin coroutines** | Async programming | Apache 2.0 | JetBrains |
| **Coil** | Load ảnh bìa | Apache 2.0 | Spotify |
| **OkHttp** | Networking | Apache 2.0 | Spotify |
| **kotlinx.serialization** | Parse JSON | Apache 2.0 | Spotify |
| **MediaMetadataRetriever** | Đọc metadata | Android SDK | Mọi app nhạc |

### 6.2 Android — Phase 2

| Library | Dùng cho | License | Học từ |
|---------|----------|---------|--------|
| **Room** | Cache thư viện nhạc | Apache 2.0 | Spotify |
| **Hilt** | Dependency injection | Apache 2.0 | Spotify, Google |
| **WorkManager** | Background tasks | Apache 2.0 | Google |
| **jaudiotagger** | Đọc/ghi metadata tags | Apache 2.0 | Nhiều app nhạc |

### 6.3 iOS — Phase 3

| Library | Dùng cho | License | Học từ |
|---------|----------|---------|--------|
| **Kingfisher** | Load ảnh bìa (tương đương Coil) | MIT | App iOS chuẩn |
| **URLSession** | Networking (built-in, tương đương OkHttp) | Apple | iOS chuẩn |
| **Codable** | Parse JSON (built-in, tương đương kotlinx.serialization) | Apple | Swift chuẩn |
| **AVFoundation** | Playback + đọc metadata (tương đương Media3 + MediaMetadataRetriever) | Apple | iOS chuẩn |
| **CoreAudio** | DAC output | Apple | iOS chuẩn |
| **Google Sign-In SDK** | Drive auth (tương đương AccountManager) | Apache 2.0 | Google |
| **FFmpeg** | Decoders (nếu cần, via AudioToolbox hoặc custom) | LGPL v2.1 | Spotify, Apple, VLC |

**Lưu ý:** iOS dùng nhiều built-in (URLSession, Codable, AVFoundation) thay vì third-party như Android. Ít dependency hơn, ít rủi ro license hơn.

### 6.4 Cả 2 platform — Phase 4

| Library | Dùng cho | License |
|---------|----------|---------|
| **Sentry** (cân nhắc) | Crash reporting (self-hosted, thay Firebase) | BSD |
| **Firebase Crashlytics** (cân nhắc) | Crash reporting (cần Firebase account) | Google ToS |

### 6.5 Không dùng

| Library | Lý do |
|---------|-------|
| **NewPipe Extractor** | AGPL-3.0 — bắt app phải open-source |
| **librespot** | Chỉ dùng cho Spotify |
| **TarsosDSP** | GPL-3.0 — không dùng trong app đóng |
| **Jellyfin FFmpeg decoder** | GPL-3.0 — đã loại, thay bằng FFmpeg LGPL |
| **Flutter** | Phải viết lại Android, app size +96% |
| **React Native** | Phải viết lại Android, FPS 42, Shopify bỏ |

### 6.6 Ông lớn dùng libraries nào?

#### Spotify

| Library | Dùng cho | License |
|---------|----------|---------|
| **Chromium Embedded Framework (CEF)** | Render UI bằng HTML5 trong desktop app | BSD |
| **Ogg Vorbis** | Encode nhạc | BSD |
| **Linux / Debian** | Backend servers (5,000+) | GPL |
| **Apache Beam** | Xử lý audio (qua Klio) | Apache 2.0 |
| **Klio** | Framework xử lý audio (Spotify tự viết, open-source) | Apache 2.0 |
| **Backstage** | Developer portal (Spotify tự viết, open-source) | Apache 2.0 |
| **FFmpeg** | Xử lý audio/video | LGPL |

**Điểm quan trọng:** Spotify nói: *"Client là proprietary (đóng), nhưng backend có rất nhiều open source components."* App đóng, libraries mở — giống dac-app.

#### Apple

| Library | Dùng cho | License |
|---------|----------|---------|
| **BSD (Darwin/XNU)** | Nền tảng macOS/iOS | BSD |
| **WebKit** | Engine trình duyệt | LGPL/BSD |
| **LLVM / Clang** | Compiler | Apache 2.0 |
| **Swift** | Ngôn ngữ lập trình (Apple tự viết, open-source) | Apache 2.0 |
| **libdispatch (GCD)** | Đa luồng | Apache 2.0 |
| **FFmpeg** | Xử lý media | LGPL |

**Điểm quan trọng:** Apple là công ty đóng nhất, nhưng vẫn dựa trên BSD (open source) cho toàn bộ OS. Họ open-source WebKit, LLVM, Swift — nhưng Apple Music app vẫn đóng.

#### VLC

| Library | Dùng cho | License |
|---------|----------|---------|
| **FFmpeg (libavcodec)** | Decode hầu hết format | LGPL |
| **libFLAC** | Decode FLAC | BSD |
| **libVorbis** | Decode Ogg Vorbis | BSD |
| **libogg** | Parse Ogg | BSD |
| **libmad** | Decode MP3 | GPL |
| **libfaad2** | Decode AAC | GPL |
| **Qt / wxWidgets** | GUI | LGPL / wxWidgets |

VLC là app open-source (GPL), nên dùng cả GPL libraries. dac-app khác: app đóng, nên không dùng GPL.

#### Kết luận

**Tất cả ông lớn đều dùng open source libraries, kể cả công ty đóng nhất như Apple.**

Pattern chung: **App đóng, libraries mở**. FFmpeg là chuẩn ngành — Spotify, Apple, VLC đều dùng. Không ai tự viết decoder từ đầu.

---

## 7. Bảo mật (học Spotify)

### 7.1 Cách Spotify xử lý bảo mật

| Vấn đề | Cách Spotify làm |
|--------|-----------------|
| **Rate limiting** | Login: 5 lần/15 phút. Sau 5 lần sai → khóa 15 phút. Luôn chạy bcrypt dù email không tồn tại (chống đoán email qua timing) |
| **Token storage** | OAuth 2.0 + PKCE. Access token 1h, Refresh token 30d. Lưu trong `EncryptedSharedPreferences` (AES-256-GCM). Mỗi lần refresh → cấp refresh token mới, thu hồi cũ (rotation) |
| **Đăng ký spam** | Email verification, hCaptcha, 2FA qua email khi login từ máy lạ, "trusted device" |
| **Session management** | User xem danh sách thiết bị đang đăng nhập, revoke từng cái. Device fingerprint (model, OS, IP, user agent) |
| **Library disclosure** | Publish Third Party Licenses trong Settings → About/Help + website |

### 7.2 Phase 1 — Làm ngay (trước launch)

| Lỗ hổng | Fix (theo Spotify) | Độ khó | Platform |
|---------|-------------------|--------|----------|
| No rate limiting login | 5 lần/15 phút, khóa 15 phút sau 5 lần sai | Dễ | Worker (dùng chung) |
| No rate limiting register | 5 đăng ký/IP/giờ | Dễ | Worker (dùng chung) |
| Token plain text | EncryptedSharedPreferences (Android) / Keychain (iOS) | Dễ | Android + iOS |
| Timing attack | Luôn chạy PBKDF2 dù user không tồn tại | Dễ | Worker (dùng chung) |
| No device info | Lưu model + OS + device ID vào session | Dễ | Android + iOS |

### 7.3 Phase 2 — Sau launch

| Tính năng | Chi tiết | Platform |
|-----------|----------|----------|
| Email verification | Resend — gửi link verify | Worker (dùng chung) |
| Quên mật khẩu | Resend — gửi link reset | Worker (dùng chung) |
| Session management UI | List sessions, revoke từng cái | Android + iOS |
| Drive scope cho Copy | Test `drive.readonly` + `drive.file` có đủ không? | Android + iOS |

### 7.4 Phase 4 — Khi user >1000

| Tính năng | Chi tiết | Platform |
|-----------|----------|----------|
| Access + Refresh token | Access 1h + Refresh 30d + rotation (như Spotify). Cần refactor auth toàn hệ thống | Worker + Android + iOS |
| 2FA | Email OTP khi login từ máy lạ | Worker (dùng chung) |
| CAPTCHA | hCaptcha khi đăng ký (nếu bị spam) | Worker (dùng chung) |

### 7.5 Kiểm tra lỗ hổng kiến trúc

**Đã ổn:**
- ✅ Worker là gate — decompile app cũng không bypass được (không có session → 401)
- ✅ Không lưu Drive token trên server
- ✅ Password hash PBKDF2 + salt ngẫu nhiên
- ✅ Session limit (kick session cũ khi vượt giới hạn)
- ✅ HTTPS cho mọi API call
- ✅ Stream URL chỉ có file của chính user, hết hạn sau ~1h

**Cần fix (Phase 1):**
- 🔴 No rate limiting → brute-force risk
- 🔴 Token lưu không mã hoá → rooted/jailbroken device risk
- 🔴 Đăng ký spam không giới hạn → no email verification/CAPTCHA

**Lỗ hổng mới từ tính năng Copy:**
- ⚠️ Scope cho Copy chưa rõ — cần test `drive.readonly` + `drive.file` có đủ không
- ⚠️ Copy có thể bị lạm dụng — giới hạn chỉ file audio, giới hạn dung lượng/ngày, log lại

---

## 8. License — Thương mại được

### 8.1 Audit license

| Thư viện | License | Thương mại được? |
|----------|---------|------------------|
| decent-player (3 modules) | MIT | ✅ Được |
| Media3 (ExoPlayer) | Apache 2.0 | ✅ Được |
| AndroidX, Kotlin | Apache 2.0 | ✅ Được |
| libFLAC | BSD | ✅ Được |
| **FFmpeg** | **LGPL v2.1** | ✅ Được (sau khi tự build, thay Jellyfin GPL) |
| Kingfisher (iOS) | MIT | ✅ Được |
| Google Sign-In SDK (iOS) | Apache 2.0 | ✅ Được |
| ~~Jellyfin FFmpeg decoder~~ | ~~GPL-3.0~~ | ❌ **Đã loại** |

### 8.2 Vấn đề GPL-3.0 (đã xử lý)

FFmpeg decoder của Jellyfin là **GPL-3.0** — license "copyleft" lan truyền:
- Nếu app chứa code GPL → toàn bộ app phải là GPL
- App GPL → bắt buộc công khai source code, ai cũng được tải về, sửa, phát hành lại miễn phí
- Không thể bán app GPL dưới dạng closed-source

**Giải pháp:** Build FFmpeg LGPL từ source, thay Jellyfin GPL.

### 8.3 Build FFmpeg LGPL

**Tham khảo GitHub:**

| Repo | Điểm mạnh |
|------|-----------|
| `gokutd/gtd-media3-ffmpeg` | ⭐ Tốt nhất — GitHub Actions, reproducible, pin commit |
| `fxpandaa/flowvid-media3-ffmpeg` | GitHub Actions publish AAR |
| `kromatv/kroma` | Hướng dẫn chi tiết từng lệnh |
| `silo-server/silo-android` | Script hoàn chỉnh + THIRD_PARTY_NOTICES |

**Cách làm (Android):**

```bash
# 0. NDK pin: 27.1.12297006 (kroma recipe, đã build thật) — CHỐT 1 NDK duy nhất
#    sdkmanager --install "ndk;27.1.12297006"
#    Ghi chú: README 1.9.3 chỉ nói "tested on NDK r26b", silo pin r26d — pin
#    27.1.12297006 là quyết định tường minh để build reproducible.

# 1. Clone Media3 ở đúng tag 1.9.3 (khớp version app — AAR phải khớp runtime)
#    LỖI CŨ ĐÃ SỬA: bản nháp hôm qua dùng tag 1.9.0 theo recipe kroma
#    (kroma build cho Media3 1.9.0 → media3-decoder-ffmpeg-1.9.0.aar).
#    AAR 1.9.0 gắn vào app 1.9.3 → ffmpeg=false mà không báo lỗi.
git clone --depth 1 -b 1.9.3 https://github.com/androidx/media.git media3

# 2. Clone FFmpeg vào folder jni của decoder
MODULE="$PWD/media3/libraries/decoder_ffmpeg/src/main"
git clone --depth 1 -b release/6.0 https://git.ffmpeg.org/ffmpeg.git "$MODULE/jni/ffmpeg"

# 3. Build FFmpeg — script của Media3 TỰ ĐỘNG không bật --enable-gpl
#    → Kết quả là LGPL, không phải GPL
cd "$MODULE/jni"
./build_ffmpeg.sh "$MODULE" "$ANDROID_NDK" linux-x86_64 21 \
  flac alac mp3 aac opus vorbis pcm_mulaw pcm_alaw ac3 eac3 dca mlp truehd

# 4. Build AAR
cd "$PWD/media3" && ./gradlew :lib-decoder-ffmpeg:assembleRelease

# 5. Lấy AAR (nằm dưới app/libs/ vì build.gradle.kts reference files("libs/..."))
cp libraries/decoder_ffmpeg/buildout/outputs/aar/lib-decoder-ffmpeg-release.aar \
   dac-player/app/libs/media3-ffmpeg-lgpl.aar

# 6. Ghi commit hash thật của CẢ Media3 và FFmpeg lúc build
#    (git rev-parse HEAD trong từng clone) vào THIRD_PARTY_NOTICES.md —
#    branch release/6.0 vẫn move, hash mới là pin thật.

# 7. Verify decoder ĐƯỢC LOAD (không chỉ ship) — kroma: đây mới là proof
#    adb logcat -d | grep "Loaded FfmpegAudioRenderer"
#    Phải thấy "DefaultRenderersFactory: Loaded FfmpegAudioRenderer."
#    + Kiểm tra ELF 16 KB page-size (silo): NDK 27 không tự align 16 KB,
#    nếu fail trên máy Android 15+ thì patch link với
#    -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384.
```

**Đã verify từ `libraries/decoder_ffmpeg/README.md` ở tag 1.9.3 (đọc trực tiếp từ GitHub 2026-10-14):** FFmpeg `release/6.0` ("We currently recommend version 6.0"). NDK **27.1.12297006** (CHỐT, theo recipe kroma đã build thật — README 1.9.3 chỉ nói "tested on NDK r26b", silo pin r26d; pin 27.1 là quyết định tường minh). Không lên FFmpeg n7.x — silo ghi rõ n7.x break JNI glue của Media3. Ghi lại commit hash của cả Media3 và FFmpeg khi build để reproducible.

**Decoders cho dac-app:** `flac alac mp3 aac opus vorbis pcm_mulaw pcm_alaw ac3 eac3 dca mlp truehd`

**Thay đổi trong dac-app (Android):**

```kotlin
// build.gradle.kts — XOÁ Jellyfin GPL:
- implementation(libs.media3.ffmpeg.decoder) // org.jellyfin.media3 — GPL!

// THAY BẰNG AAR tự build (LGPL):
+ implementation(files("libs/media3-ffmpeg-lgpl.aar"))
```

Không đổi code Kotlin nào — Media3 tự nhận `FfmpegAudioRenderer` qua reflection.

**GitHub Actions:** Tạo workflow build FFmpeg LGPL AAR (chạy 1 lần, 20-45 phút, dùng AAR đó cho nhiều build APK sau). Reproducible — ai cũng build lại được AAR giống hệt.

**Kích thước:** FFmpeg static libs ~46MB (trung gian) → sau link ~1.5MB/ABI → AAR cuối ~3.2MB → APK tăng ~3MB (21MB → 24MB).

**iOS:** Dùng FFmpeg qua AudioToolbox (built-in) hoặc build FFmpeg LGPL cho iOS tương tự (nếu cần decoders không có sẵn). iOS có sẵn decoders cho FLAC, ALAC, AAC, MP3 — có thể không cần FFmpeg.

### 8.4 Nghĩa vụ LGPL

| Việc | Cách làm |
|------|----------|
| Cung cấp source FFmpeg | Link tới git.ffmpeg.org + ghi commit hash trong repo |
| Ghi license | File `THIRD_PARTY_NOTICES.md` trong app, ghi "FFmpeg LGPL v2.1+" |
| Cho phép thay thế lib | AAR chứa FFmpeg dưới dạng `.so` riêng (dynamic link) — user có thể thay `.so` khác |
| Không sửa FFmpeg | Dùng FFmpeg nguyên bản, không patch. Nếu có patch → phải công khai patch |

### 8.5 Công khai libraries (học ông lớn)

**Tất cả ông lớn đều công khai libraries họ dùng:**

| Công ty | Cách công khai |
|---------|---------------|
| **Spotify** | Settings → About/Help → "Third Party Software Licenses" + website |
| **Apple** | Settings → General → About → Legal |
| **Discord** | Settings → "Acknowledgements" + "Open Source Licenses" |
| **Slack** | Settings → Help → "Privacy & terms" |
| **1Password, Bitwarden** | Settings → About → Licenses |

**Pattern chuẩn ngành:** Settings → About → Licenses/Acknowledgements.

**Áp dụng cho dac-app:** Thêm màn hình Settings → About → "Open Source Licenses" (hiển thị `THIRD_PARTY_NOTICES.md`), giống Spotify/Discord. Làm cho cả Android và iOS.

### 8.6 Open Source Libraries — Giải thích

**Định nghĩa:** Open source libraries = **code người khác viết sẵn, cho mình dùng miễn phí** theo một giấy phép (license).

Giống như xây nhà: Thay vì tự làm gạch, xi măng, cửa sổ từ đầu, mình mua gạch, xi măng, cửa sổ có sẵn rồi xây nhà theo thiết kế của mình. **Ngôi nhà (app) là của mình, vật liệu (libraries) là của người khác cho mình dùng.**

**Code nào là của mình, code nào là library?**

```
dac-app (của mình — giữ kín được):
├── Màn hình Auth (login/register)
├── Màn hình Music Library
├── Logic gọi Drive API (list, stream, copy)
├── Logic kết nối Pocket Personal (auth)
├── UI/UX của app
└── Cách kết nối các libraries lại với nhau

Libraries (của người khác — dùng theo license):
├── decent-player → Driver USB DAC (Android)
├── Media3 → Framework phát nhạc (Android)
├── AVFoundation → Framework phát nhạc (iOS)
├── FFmpeg → Giải mã audio
├── libFLAC → Giải mã FLAC
└── AndroidX / SwiftUI → UI components
```

**"Open source libraries" ≠ "App phải open source".**

Mình dùng vật liệu open source để xây app, nhưng app là của mình. Giống như xây nhà bằng gạch mua sẵn — nhà vẫn là của mình, không phải của người bán gạch.

Chỉ có GPL mới bắt app phải open source. Mình đã loại GPL (thay Jellyfin bằng FFmpeg LGPL). Giờ dac-app **dùng toàn libraries cho phép thương mại đóng**.

---

## 9. Triển khai (học Spotify)

### 9.1 Cách Spotify triển khai

| Hạng mục | Cách Spotify làm |
|----------|-----------------|
| **CI/CD** | GitHub Actions + Backstage. Commit → Actions chạy lint, test, build → ArgoCD deploy |
| **Release** | Bi-weekly (2 tuần/lần) cho mobile. Branch tự động cắt, không cần quyết định tay |
| **Feature flags** | LaunchDarkly — bật/tắt tính năng mà không cần release app mới |
| **Monitoring** | Grafana — dashboard + alerts |
| **Deploy** | Hàng trăm lần/tuần, squads tự sở hữu pipeline |

### 9.2 Áp dụng cho dac-app (đơn giản hơn, 0đ cho Android)

| Hạng mục | Android | iOS |
|----------|---------|-----|
| **CI/CD** | GitHub Actions (Linux runner) | GitHub Actions (macOS runner) |
| **Release** | Manual — khi nào xong feature thì build + deploy | Manual — khi nào xong feature thì build + deploy |
| **Version** | Hiển thị version trong app + SHA256 + link GitHub run trên trang `/dac` | Hiển thị version trong app + build number trong TestFlight |
| **Deploy** | APK qua `lethanhdong.one/dac` (không Play Store, tránh phí $25) | TestFlight/App Store ($99/năm) hoặc AltStore (free) |
| **Verify** | Tải APK live về, check SHA256 khớp, grep DEX tìm string đặc trưng | Tải IPA, check version, test trên device |

**Quy trình Android (đã áp dụng):**
```
Push code → GitHub Actions build APK (3 phút) → Tải artifact →
Verify (SHA256 + DEX strings) → Copy APK → Deploy via cf_deploy.py →
Verify live (SHA256 + curl) → Báo cáo
```

**Quy trình iOS:**
```
Push code → GitHub Actions (macOS runner) build IPA →
Download IPA từ Artifacts →
Cài lên iPhone qua AltStore/Sideloadly (free) hoặc TestFlight ($99) →
Test trên device → Báo cáo
```

**Build IPA không cần $99:** Dùng free Apple ID, app hết hạn 7 ngày, cài qua AltStore. $99 chỉ cần khi muốn TestFlight/App Store.

---

## 10. Tính năng

### 10.1 Xác thực (như Spotify) — Cả 2 platform

| Flow | Chi tiết |
|------|----------|
| **Đăng ký** | Email + mật khẩu (min 8 ký tự) → Worker tạo user → Gửi email verify qua Resend → Auto-login |
| **Đăng nhập** | Email + mật khẩu → Worker verify → Trả session token → Vào thư viện |
| **Đăng xuất** | Xoá session trên Worker + xoá token local → Về màn hình Auth |
| **Quên mật khẩu** | Gửi email reset qua Resend (Phase 2) |
| **Verify email** | User bấm link trong email → Worker đánh dấu verified |

**Tài khoản là một:** Đăng ký qua Android → đăng nhập iOS được luôn. Và ngược lại.

### 10.2 Nghe nhạc — Cả 2 platform

| Tính năng | Chi tiết |
|-----------|----------|
| **Duyệt nhạc** | Cây thư mục Drive + list file audio (filter: FLAC, WAV, MP3, AAC...) — Phase 4.1 |
| **Tìm kiếm** | Tìm theo tên file (Phase 4.8: theo metadata, dùng D1 index) |
| **Phát** | Stream trực tiếp từ Drive → Player → USB DAC bit-perfect |
| **Phát local** | Chọn file trên máy → phát qua DAC |
| **Cache** | Phase 4.2: D1 index + sync tăng dần; Phase 4.3: cache offline bài đã nghe |
| **Hiển thị** | Version app, tên bài, trạng thái DAC |

### 10.3 Copy nhạc từ folder share — Cả 2 platform

| Bước | Chi tiết |
|------|----------|
| **Paste link** | User paste link Drive share (file hoặc folder) |
| **List** | App gọi Drive API list nội dung folder share |
| **Chọn** | User chọn file/folder muốn copy (hoặc copy tất cả) |
| **Copy** | App gọi Drive API `files.copy` — server-side, ~30 giây cho 10GB |
| **Tạo folder** | Tự động tạo folder đích trong Drive user, giữ cấu trúc |
| **Progress** | Hiển thị tiến trình copy (x/y file) |
| **Fallback** | Nếu copy bị chặn (owner tắt quyền) → tạo shortcut hoặc download+upload |

**Không dùng rclone.** Drive API `files.copy` = cùng tốc độ rclone (vì rclone cũng gọi API này), nhưng nhúng được vào app, UX tốt hơn.

**So sánh tốc độ copy (folder 10GB, 100 file FLAC):**

| Cách | Thời gian | Băng thông |
|------|-----------|-----------|
| Drive API `files.copy` | ~30 giây | 0 MB |
| rclone server-side | ~30 giây | 0 MB |
| Download + Upload | ~80 phút | 20GB |

Drive API nhanh hơn Download+Upload ~80 lần vì copy trên server Google, không qua máy user.

### 10.4 DAC Playback

#### Android

| Hạng mục | Chi tiết |
|----------|----------|
| **Engine** | decent-player (MIT) — USB driver + Media3 decoder |
| **Bypass** | Bypass hoàn toàn Android AudioFlinger → bit-perfect |
| **Decode** | Media3 built-in (WAV, MP3, AAC) + decent FLAC decoder (MIT) + FFmpeg LGPL (APE, ALAC, etc.) |
| **Volume** | Không dùng volume hệ thống cho USB output (giống UAPP bit-perfect mode) |
| **Format** | FLAC, WAV, MP3, AAC, ALAC, APE, Opus, Vorbis |
| **Chưa có** | Gapless, EQ/DSP (EQ phá bit-perfect nên không ưu tiên) |

#### iOS

| Hạng mục | Chi tiết |
|----------|----------|
| **Engine** | AVAudioSession + AVFoundation (AVPlayer) |
| **Bypass** | Không có true bypass (iOS không cho). Nhưng iOS không resample như Android |
| **Decode** | AVFoundation built-in (FLAC, ALAC, AAC, MP3) + FFmpeg LGPL (nếu cần APE, etc.) |
| **Volume** | Volume = 100%, không EQ, không processing |
| **Sample rate** | Set `preferredSampleRate` = sample rate file (vd: 96kHz) |
| **Format** | FLAC, WAV, MP3, AAC, ALAC, APE, Opus, Vorbis |
| **Chưa có** | Gapless, EQ/DSP |

**So sánh công nghệ DAC:**

| App | Công nghệ DAC | Bypass? | Bit-perfect? | License |
|-----|--------------|---------|--------------|---------|
| UAPP | USB driver riêng (đóng) | ✅ Bypass hoàn toàn | ✅ Có | Đóng, $8 |
| Poweramp | Android Hi-Res API + DVC | ❌ Dùng Android direct | ⚠️ Tùy máy | Đóng, $5 |
| Resonāda | Oboe + USB driver riêng | ✅ Bypass hoàn toàn | ✅ Có | Freeware |
| Shikardos | USB driver riêng | ✅ Bypass hoàn toàn | ✅ Có | Mở |
| Andiophile | just_audio / CoreAudio | ❌ Android, ✅ macOS | ❌ Android, ✅ macOS | Mở |
| **dac-app Android** | **decent-player (MIT)** | ✅ **Bypass hoàn toàn** | ✅ **Có** | **MIT, 0đ** |
| **dac-app iOS** | **AVAudioSession** | ❌ **Không bypass** | ⚠️ **Gần đúng** | **Apple, 0đ** |

dac-app Android dùng cùng phương pháp "true bypass" như UAPP và Resonāda — phương pháp tốt nhất, đảm bảo bit-perfect trên mọi máy. iOS không có true bypass, nhưng iOS không resample như Android nên vẫn đạt gần bit-perfect.

---

## 11. Tiềm năng thị trường

### 11.1 App tương tự

| App | Giá | DAC Bit-perfect | Google Drive | Account | Copy từ share |
|-----|-----|----------------|--------------|---------|---------------|
| UAPP | $7.99 | ✅ | ❌ | ❌ | ❌ |
| Resonāda | Free | ✅ | ❌ | ❌ | ❌ |
| Shikardos | Free | ✅ | ✅ (play từ link) | ❌ | ❌ |
| Andiophile | Free | ⚠️ (macOS only) | ✅ (download) | ❌ | ❌ |
| Audiophiles Dream | Free | ✅ | ❌ | ❌ | ❌ |
| **dac-app** | **0đ (Android), $99/năm (iOS)** | ✅ (Android), ⚠️ (iOS) | ✅ (stream) | ✅ | ✅ (sắp có) |

Không có app nào làm đủ 5 thứ như dac-app.

### 11.2 Điểm mạnh độc nhất

- **"Spotify cho nhạc của chính bạn"** — User có kho FLAC trên Drive, app phát bit-perfect qua DAC
- **Copy từ folder share** — Tính năng độc quyền. User A share folder nhạc → User B bấm 1 nút → copy về Drive mình → nghe ngay
- **0đ (Android)** — UAPP $8, Poweramp $5. Mình free cho Android.
- **Native cả 2 platform** — Hiệu năng tốt nhất, không compromise như Flutter/RN
- **Pocket Personal ecosystem** — Cùng tài khoản dùng được English Lab, Stocks, Voice...

### 11.3 Thị trường

- Audiophile: Niche nhưng trung thành, sẵn sàng trả tiền cho chất lượng
- Người có kho nhạc Drive: Hàng triệu người dùng Gmail có Drive, nhiều người lưu FLAC
- Việt Nam: Tầng lớp trung lưu tăng, quan tâm Hi-Fi, thích hàng free chất lượng
- iOS: User iOS thường chi tiêu nhiều hơn Android, sẵn sàng trả cho app chất lượng

### 11.4 Rủi ro

- Niche market — không phải app đại chúng như Spotify
- Cần DAC thật để trải nghiệm đủ — user không có DAC thì chỉ nghe như app thường
- Google có thể đổi Drive API bất cứ lúc nào
- iOS cần $99/năm — chi phí duy trì
- iOS không có true bypass — giá trị bit-perfect yếu hơn Android

---

## 12. 8b Checklist

**Trước khi code (mọi Phase):**
- [ ] Đọc `RULES.md` mục 8b + `CHECKLIST.md` + skill `english-lab-fix`
- [ ] Một việc một lúc, test pass mới sửa tiếp
- [ ] Cấm replace hàng loạt bằng regex khi chưa đọc từng chỗ
- [ ] Không nhúng JS phức tạp vào thuộc tính HTML
- [ ] Không tối ưu khi app chưa ổn định
- [ ] Sửa gốc, không vá tạm
- [ ] Sau mỗi lần sửa chạy `node --check` (JS) / build check (Kotlin/Swift) và đọc lại bằng mắt
- [ ] Deploy xong test live ngay đúng chức năng vừa sửa

**Khi code:**
- [ ] Không bịa giá trị từ API ngoài — verify bằng request thật trước khi code
- [ ] Ghi nguồn verify trong comment
- [ ] Suy nghĩ trước, trình đề xuất, Chốt rồi mới code
- [ ] Nghiên cứu cách ông lớn xử lý trước khi đề xuất kiến trúc/giải pháp

**Khi deploy:**
- [ ] Verify bằng hash/build-id trên live, không tin "DEPLOY OK" suông
- [ ] Check JS dạng .mjs (vì `node --check` thường không bắt lỗi ES module)
- [ ] Tự test bằng browser/device thật, không nhờ user test
- [ ] Dọn sạch data test sau khi xong
- [ ] Mỗi build mới tăng versionCode/versionName (Android) / build number (iOS)

**Khi test bug:**
- [ ] Test frontend + backend đồng thời
- [ ] Tạo data test riêng, không động data thật
- [ ] Không dùng token/session thật của user
- [ ] Dọn sạch sau khi xong

---

## 13. Chi phí tổng

| Hạng mục | Android | iOS | Tổng |
|----------|---------|-----|------|
| Build (GitHub) | 0đ | 0đ (repo public) | 0đ |
| Phân phối | 0đ (APK qua web) | **$99/năm** | **$99/năm** |
| Developer account | — | $99/năm | $99/năm |
| Email (Resend) | 0đ (free tier) | 0đ (dùng chung) | 0đ |
| Backend (Cloudflare) | 0đ (free tier) | 0đ (dùng chung) | 0đ |
| **Tổng** | **0đ** | **$99/năm** | **$99/năm** |

**Lưu ý:** Có thể trì hoãn $99/năm cho iOS bằng cách build IPA với free Apple ID (app hết hạn 7 ngày, cài qua AltStore). $99 chỉ cần khi muốn TestFlight/App Store.

---

## 14. Tài liệu tham khảo

### FFmpeg LGPL Build
- `gokutd/gtd-media3-ffmpeg` — Reproducible build, GitHub Actions
- `fxpandaa/flowvid-media3-ffmpeg` — LGPL AAR, GitHub Actions publish
- `maxscharwath/kroma` — Hướng dẫn chi tiết từng lệnh
- `silo-android` — Script hoàn chỉnh + THIRD_PARTY_NOTICES

### DAC Technology
- `Ma145/decent-player` — USB DAC driver + Media3 wrapper (MIT)
- Media3 `decoder_ffmpeg` — Module source (Apache 2.0), cần build FFmpeg riêng
- Apple AVAudioSession + AVFoundation — iOS audio framework
- Apple CoreAudio — macOS exclusive mode (Hog Mode), không có trên iOS

### Bảo mật (Spotify pattern)
- Rate limiting: 5 lần/15 phút, khóa 15 phút
- Token: EncryptedSharedPreferences (Android) / Keychain (iOS), Access 1h + Refresh 30d + rotation
- Email verification + trusted device + 2FA

### Triển khai (Spotify pattern)
- GitHub Actions CI/CD + feature flags + monitoring
- Bi-weekly releases, automated branch cutting

### Cross-platform (tham khảo, đã quyết Native)
- Shopify bỏ React Native 2026 — cold start -50%, APK -109MB, stability 99.5% → 99.95%
- Airbnb bỏ React Native 2018 — performance không đáp ứng
- Netflix dùng KMP — share logic, UI native
- Benchmark 2025: Native 6.16MB/119FPS, KMP 6.18MB/119FPS, Flutter 12.08MB/120FPS, RN 11.56MB/42FPS

---

*Plan "dac-app" — Chốt 2026-10-13 — Native Android (Kotlin) + iOS (Swift)*
