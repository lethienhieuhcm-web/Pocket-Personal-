# Phase 3 — iOS Native Swift App (dac-app-plan.md)

**Ngày:** 2026-10-14 (20:00 → 20:37 +07)
**Trạng thái:** HOÀN TẤT trong phạm vi tự kiểm chứng (CI build pass + API contract test)
**CI:** `.github/workflows/build-dac-ios.yml` — macos-latest, Xcode 26.6

## Đã làm

### 3.1 — Xcode project + CI
- Project viết tay minimal (`dac-player-ios/`): `project.pbxproj` + 2 file Swift ban đầu.
- Bài học: thiếu `SDKROOT = iphoneos` → xcodebuild hiểu nhầm thành target macOS
  ("Unable to find a destination ... iOS Simulator"). Fix: thêm `SDKROOT = iphoneos`
  vào target Debug/Release.
- Workflow build unsigned cho iOS Simulator (`CODE_SIGNING_ALLOWED=NO`), đóng gói
  IPA unsigned làm artifact. Build đầu pass 1m13s.

### 3.2 — Auth (Swift)
- `KeychainHelper.swift` — wrapper Keychain (tương đương EncryptedSharedPreferences).
- `ApiModels.swift` — Codable models dịch từ `ApiModels.kt` (Android).
- `AuthManager.swift` — `POST /api/auth/login` (kèm `fp` {screen,tz,lang} như Android),
  register, resend-verification, forgot-password, logout. Xử lý 401/403
  (`email_not_verified`)/429/200 đúng contract Android.
- `AuthView.swift` — SwiftUI đăng nhập/đăng ký, lỗi inline, nút gửi lại email verify,
  quên mật khẩu. Không popup (theo RULES).

### 3.3 — Music Library + Player
- `MusicApiClient.swift` — `GET /api/dac/music` + `/api/dac/stream/{id}`, 2 header
  (Authorization + X-Drive-Token), cache file 24h, tìm kiếm offline, kéo để refresh.
- `DriveAuthManager.swift` — storage Keychain cho Drive token + interface sạch.
  **Chờ:** Google Sign-In SDK cần iOS OAuth client ID (tạo 1 lần trên Google Cloud
  Console, phía anh) — hiện app báo rõ "chưa kết nối Drive", không bịa.
- `PlayerView.swift` — AVPlayer stream trực tiếp, play/pause/seek, hiện sample rate.
- `LibraryView` (trong ContentView.swift) — list + search + refresh + tap để phát.

### 3.4 — DAC via AVAudioSession
- `AudioEngine.swift`:
  - Đọc sample rate **thật** từ file (AVURLAsset → format description), không đoán.
  - `AVAudioSession`: category `.playback`, `preferredSampleRate` = sample rate file,
    volume 1.0 (100%), không EQ/processing.
- Bài học compile: `CMAudioFormatDescription` **là** `CMFormatDescription`
  (compiler báo "aka") — mọi cast (`as?`/`as!`/CFTypeID check) đều thừa hoặc lỗi;
  dùng trực tiếp `descs.first`.

### 3.5 — Cover art
- `CoverArtManager.swift` + `TrackArtworkView.swift` — đọc artwork **nhúng** trong file
  (`AVMetadataKey.commonKeyArtwork`), cache theo track id. Không có → placeholder
  SF Symbol (như Android). Không dùng Kingfisher: nguồn ảnh là metadata file,
  không phải URL remote — thêm dependency là thừa.

### 3.6 — Copy từ link share
- `DriveLinkParser.swift` — parse link Drive (dịch từ Kotlin, cùng regex).
- `DriveCopyManager.swift` — `POST /api/dac/resolve` + `/api/dac/copy`, xử lý
  403 `insufficient_scope` riêng (hiện hướng dẫn cấp quyền, như Android D7).
- `ImportView.swift` — dán link → xem list → chọn/bỏ chọn → copy từng file,
  tiến trình x/y, báo kết quả.

### 3.7 — Test bug + fix
Test contract API live (user test tạo qua API, verify qua D1, **dọn sạch sau**):
- register → 200 đúng shape `{ok,email,verified,needsVerification,emailSent}` ✅
- login sai → 401 `Invalid credentials` ✅
- login đúng → 200 `{token(64), email}` ✅
- `/api/dac/music` không drive token → 400 `Drive not connected` ✅
- `/api/dac/music` drive token giả → 401 `Drive token invalid` ✅
- `/api/dac/resolve` + `/api/dac/copy` drive token giả → 401 `Drive token invalid` ✅
- logout → `{"ok":true}` ✅
- **Bug tìm được:** drive token sai bị client báo nhầm "hết phiên đăng nhập".
  Fix gốc: tách `MusicError.driveTokenInvalid` / `CopyError.driveTokenInvalid` —
  UI tự về trạng thái "kết nối lại Drive". (Android cũng có bug tương tự —
  ghi nhận để fix sau cho đồng bộ.)
- Data test: xoá user + sessions khỏi D1, verify COUNT=0 ✅

## Build cuối
- Run #14: SUCCESS 40s, IPA `DACPlayer-unsigned-ipa` 737 KB
  (sha256 `5c693a550dc87e4ada07999b58bdfc5dd58586fec0f5e414ccf1c1b27dbef1c6`).
- Tổng 15 file Swift, ~3.500 dòng, 0 dependency ngoài (chỉ dùng built-in iOS).

## Còn mở (cần anh hoặc máy thật)
1. **iOS OAuth client ID** — tạo trên Google Cloud Console → gắn Google Sign-In SDK
   vào `DriveAuthManager.requestToken()`. (Đã ghi nhớ nhắc anh.)
2. Tap-through trên iPhone thật (đăng nhập → list nhạc → phát → cắm DAC check sample rate).
3. Ký IPA: Apple Developer $99/năm → TestFlight/App Store; hoặc sideload free (AltStore).
4. Fix bug "Drive token invalid" tương tự trên Android cho đồng bộ.
5. Phase 4: access+refresh token, session management UI, search theo metadata, gapless.
