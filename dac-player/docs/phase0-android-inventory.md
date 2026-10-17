# Phase 0.2 — Inventory code Android hiện tại (dac-app)

**Ngày kiểm tra:** 2026-10-13 (giờ VN, Asia/Saigon)
**Người kiểm tra:** Muse — đọc trực tiếp từng file, không đoán từ kế hoạch cũ.
**Phạm vi:** `~/workspace/english-lab/dac-player/` (project Android thật) + `~/workspace/english-lab/worker/src/` (Worker) + `~/workspace/english-lab/dac.html` (trang tải).

## 0. Kết luận nhanh (đọc trước)

- Project Android thật là **`dac-player/`**, KHÔNG phải `dac-app/` như giả định trong plan chi tiết.
  Không tồn tại thư mục `dac-app/` (đã `find` toàn workspace). Plan chi tiết giả định cấu trúc
  `dac-app/android|ios|worker` — **sai so với thực tế**. Thực tế là monorepo `english-lab/`:
  `dac-player/` (Android) + `worker/src/` (Worker) + `dac.html` + `dac-player-debug.apk`.
- App hiện tại đã chạy được luồng **dac-pass**: login → Drive (AccountManager) → list nhạc → stream → USB DAC.
- Nhưng **Phase 1 còn nguyên**: token lưu plain text, chưa có rate-limit theo (IP+email),
  chưa có EncryptedSharedPreferences, chưa có OkHttp/Coil/serialization, **vẫn còn Jellyfin GPL**,
  chưa có AuthActivity riêng, chưa có nút logout trên UI.
- Có **bản copy cũ** `~/workspace/dac-player/` — THIẾU `AuthManager.kt`, `DriveAuthManager.kt`,
  `TrackAdapter.kt` và khác 6 file so với bản thật. **Không dùng bản copy này. Chỉ dùng
  `~/workspace/english-lab/dac-player/`.** (Cần dọn/xoá bản copy sau khi anh Chốt — tránh sửa nhầm.)

## 1. Cấu trúc thật

```
~/workspace/english-lab/
├── dac-player/                      # Android app (Kotlin) — PROJECT THẬT
│   ├── app/
│   │   ├── build.gradle.kts         # versionCode 2, versionName 0.2.0-dac-pass
│   │   └── src/main/
│   │       ├── AndroidManifest.xml  # 1 Activity duy nhất: MainActivity
│   │       ├── res/layout/activity_main.xml
│   │       ├── res/xml/usb_audio_device_filter.xml
│   │       └── java/one/lethanhdong/dac/
│   │           ├── MainActivity.kt  # 221 dòng — auth + library + player trộn chung
│   │           └── player/
│   │               ├── AuthManager.kt         # 103 dòng
│   │               ├── DriveAuthManager.kt    # 107 dòng
│   │               ├── MusicApiClient.kt      # 150 dòng
│   │               ├── PlayerManager.kt       # 63 dòng
│   │               ├── DacRenderersFactory.kt # 78 dòng
│   │               └── TrackAdapter.kt        # 61 dòng
│   ├── decent-player/               # git submodule, sparse-checkout CHỈ libs/
│   │   └── libs/ (3 modules MIT, xem §5)
│   ├── gradle/libs.versions.toml
│   ├── settings.gradle.kts          # composite build decent-player/libs
│   ├── build.gradle.kts             # AGP 9.1.0
│   └── docs/                        # Phase 0 docs (file này + 3 file còn lại)
├── worker/src/
│   ├── auth.js   # 446 dòng — register/login/logout/sessions/OTP Resend
│   ├── dac.js    # 96 dòng — /api/dac/music + /api/dac/stream (dac-pass)
│   └── index.js  # ROUTES + RATE_LIMITS (IP-based, xem §6)
├── dac.html                         # Trang /dac — DAC Pocket, v0.2.0-dac-pass
├── dac-player-debug.apk             # 21 MB (bản trên disk, xem §7)
└── .github/workflows/build-dac-apk.yml  # CI build debug APK (không ở trong dac-player/)
```

Không có: `ios/` (chưa tạo — đúng theo plan, Phase 3 mới làm), `docs/THIRD_PARTY_NOTICES.md`
(chưa có trước Phase 0 — nay tạo ở `dac-player/docs/`), `docs/DECISIONS.md` (nay tạo).

## 2. Activities / Screens (thật)

| Màn hình | File | Ghi chú |
|---|---|---|
| MainActivity (duy nhất) | `MainActivity.kt` (221 dòng) | Trộn 3 việc: form login/register + list nhạc + nút phát. **Không có AuthActivity riêng** (Phase 1.3 phải tách). |
| Không có | — | Không có Settings / About / Licenses screen (Phase 1.5 yêu cầu thêm). |
| Không có | — | Không có màn hình Import/Copy (Phase 2.1), không có Session UI (Phase 4.2). |

Layout `activity_main.xml`: `statusText` + `versionText` + `loginForm` (emailInput, passwordInput,
loginButton, registerButton) + `trackList` (RecyclerView) + `pickButton` (File local) +
`playPauseButton` (Phát/Dừng). **Không có nút Logout, không có nút refresh, không có nút Drive.**

## 3. Token lưu trữ (thật — chưa mã hoá)

| Token / dữ liệu | Nơi lưu | File | Mã hoá? |
|---|---|---|---|
| Session Pocket Personal `authToken` + `authEmail` | SharedPreferences `pp_auth` | `AuthManager.kt:24` | **KHÔNG** — plain text. `AuthManager.token()` chỉ `trim().removeSurrounding("\"")`. |
| Tài khoản Drive đã chọn `drive_account` | SharedPreferences `dac_drive` | `DriveAuthManager.kt:32` | KHÔNG — plain text (chỉ tên account, không phải token). |
| Drive access token | AccountManager (hệ thống) — không lưu tay | `DriveAuthManager.kt` | Do hệ thống quản lý. Worker KHÔNG lưu Drive token (đúng dac-pass). |
| Cache list nhạc `music_list` + `music_list_time` (TTL 24h) | SharedPreferences `dac_music_cache` | `MusicApiClient.kt:46` | KHÔNG — JSON plain text (cache, không phải secret, chấp nhận được). |

**Kết quả grep:** `EncryptedSharedPreferences` = 0 hit trong toàn `dac-player/app/`.
→ Phase 1.2 bắt buộc: chuyển `pp_auth/authToken` sang EncryptedSharedPreferences + migrate + xoá cũ.

`AuthManager.logout()` tồn tại (xoá `authToken` + `authEmail`) nhưng **không được gọi ở đâu**:
grep `logout|Logout` trong `app/` chỉ hit đúng định nghĩa hàm. UI không có nút logout →
user đã login không có cách logout trong app. Phase 1.3 phải thêm.

## 4. Networking / JSON / Libraries (thật)

| Hạng mục | Thật trong code | Plan Phase 1 yêu cầu | Trạng thái |
|---|---|---|---|
| HTTP client | `HttpURLConnection` (`AuthManager.kt`, `MusicApiClient.kt`) | OkHttp 4.12.0 | **Chưa có** — phải thay (Phase 1.4). |
| JSON | `org.json.JSONObject` parse tay | kotlinx.serialization-json 1.7.3 | **Chưa có** — phải thay (Phase 1.4). |
| Ảnh bìa | Không load ảnh (TrackAdapter chỉ text + badge) | Coil 2.7.0 | **Chưa có** (Phase 1.4). |
| Metadata | Không đọc metadata file (chỉ `substringBeforeLast(".")` làm title) | MediaMetadataRetriever | **Chưa có** (Phase 1.4). |
| Cache DB | SharedPreferences JSON (list nhạc) | Room 2.6.1 | **Chưa có** (Phase 2.3). |
| DI | Không có | Hilt 2.52 | **Chưa có** (Phase 2.3). |
| Background | Không có | WorkManager 2.9.1 | **Chưa có** (Phase 2.3). |
| Tag edit | Không có | jaudiotagger 3.0.1 | **Chưa có** (Phase 2.3). |

## 5. Media3 + Decoder + decent-player (thật)

`gradle/libs.versions.toml` (đã đọc trực tiếp):
- AGP `9.1.0`, Kotlin `2.2.20`, Media3 `1.9.3`, core-ktx `1.18.0`, appcompat `1.7.1`,
  coroutines `1.10.2`, recyclerview `1.4.0`, lifecycle `2.9.2`.
- **FFmpeg decoder: `org.jellyfin.media3:media3-ffmpeg-decoder:1.9.0+1` — GPL-3.0.**
  Comment trong file còn ghi "doc ma145 ghi 1.9.0+1 (org.jellyfin.media3)".
  → **Xác nhận: APK hiện tại CHỨA Jellyfin GPL.** Phase 1.5 bắt buộc thay bằng FFmpeg LGPL tự build.
  Không có file AAR nào trong `app/libs/` (thư mục `libs/` chưa tồn tại).

`app/build.gradle.kts`:
- `namespace` + `applicationId` = `one.lethanhdong.dac`
- `versionCode = 2`, `versionName = "0.2.0-dac-pass"`
- `minSdk = 29`, `targetSdk = 36`, `compileSdk = 36`, `ndkVersion = "29.0.14206865"`,
  `abiFilters = ["arm64-v8a"]` (chỉ ARM64), Java 21, `viewBinding = true`, `isMinifyEnabled = false`.
- Signing: đọc keystore từ env `Dac_KEYSTORE_B64` (CI) hoặc file `dac-release.keystore` (local, không commit).
- Dependencies: core-ktx, appcompat, coroutines, recyclerview, lifecycle-runtime,
  media3-exoplayer/ui/session, `media3-ffmpeg-decoder` (Jellyfin GPL — cần xoá),
  + 3 modules decent-player qua composite build:
  `com.decent.usbaudio:decent-usb-audio-driver:0.1.0`,
  `com.decent.usbaudio:decent-usb-audio-wrapper-media3:0.1.0`,
  `com.decent.usbaudio:decent-media3-decoder-flac:0.1.0`.

`decent-player/` (submodule, sparse-checkout chỉ `libs/`):
- `libs/decent-usb-audio-driver`, `libs/decent-usb-audio-wrapper-media3`,
  `libs/decent-media3-decoder-flac`. LICENSE = MIT (Copyright (c) 2026 Marcelo Silva — đã đọc 5 dòng đầu).
- **Không có `driver/Felicity/` (AGPL-3.0)** trong checkout — đúng, đã tránh.
- CI pin commit `d039f9d6b1ec30901a5cd6edf72c29cde362a549` (trong `build-dac-apk.yml`).

`DacRenderersFactory.kt`: `UsbAudioSink` wrap `DefaultAudioSink`, `setExtensionRendererMode(PREFER)`
(ép FFmpeg cho format không phải FLAC vì MediaCodec cắt 24-bit → 16-bit),
`wrapLoadControl` theo doc ma145. `PlayerManager.kt`: ExoPlayer + `attachToPlayer()`,
`playLocal()` + `playStream()`.

## 6. Worker — tóm tắt liên quan Android (chi tiết ở phase0-worker-verify.md)

- Auth: `POST /api/auth/register|login|logout`, `GET /api/auth/me|sessions`,
  `POST /api/auth/sessions/revoke`, `POST /api/auth/send-code|verify-code` (OTP 6 số qua Resend).
  PBKDF2 100k SHA-256, session 7 ngày, giới hạn session đồng thời (kick cũ).
- **Rate limiting đã có nhưng KHÁC plan:** `index.js` RATE_LIMITS = IP-based
  (login 10/phút/IP, register 5/giờ/IP, send-code 3/giờ/IP, verify-code 10/phút/IP).
  Plan 1.1 yêu cầu 5 lần sai/(IP+email)/15 phút + khoá 15 phút + timing equalization.
  **Chưa có:** `handleLogin` return 401 ngay khi user không tồn tại, KHÔNG chạy PBKDF2 →
  timing leak còn tồn tại. Phase 1.1 phải thêm lớp per-(IP+email) + timing, KHÔNG xoá lớp IP-based hiện có.
- DAC: `GET /api/dac/music`, `GET /api/dac/stream/{id}` (dac-pass, Worker không lưu Drive token,
  verify file audio chặn IDOR). Đã xoá upload/copy (đúng Chốt 2026-10-13).
- Email: Resend đã dùng cho OTP code (`from: Pocket Personal <noreply@lethanhdong.one>`,
  key `env.RESEND_API_KEY`). **Chưa có:** verify-email link sau register, forgot-password link
  (Phase 2.2 phải làm mới, tái dùng helper Resend đã có, không viết lại).
- `handleRegister` KHÔNG gửi email, KHÔNG đặt `verified=false`, không kiểm tra `verified/`.
  OTP `verified/{email}.json` chỉ phục vụ flow send-code/verify-code, không gắn với register/login.
- Sessions list/revoke (backend) ĐÃ có → Phase 4.2 chỉ cần làm UI, không cần làm lại backend.

## 7. Trang /dac + APK (thật)

`dac.html` (đã đọc): title "DAC Pocket — Tải APK", nút tải `/dac-player-debug.apk`,
meta: "Phiên bản 0.2.0-dac-pass • Build 13/10/2026", "Nghe nhạc trực tiếp từ Google Drive • Không cần copy",
SHA256 trên trang: `c756ef0e0bf0b33cd27994fec1eb9ecbaf18993011db86d995d623cd5d372b63`,
link GitHub run `38362585706`.
- **Lưu ý 8b:** version trên trang (0.2.0-dac-pass) khớp `versionName` trong code.
  SHA256 trên trang cần verify lại bằng cách tải APK live về + `sha256sum` trước khi tin
  (đã chạy lệnh tải/verify ở Phase 0.3 — xem kết quả trong `phase0-worker-verify.md` §5;
  file `/tmp` đã xoá sau khi check).

## 8. Git trạng thái lúc inventory

- `cd ~/workspace/english-lab && git log --oneline -5 -- dac-player/`:
  `53e7062 dac-pass: Worker + App chuyển sang Drive passthrough` (mới nhất).
- `git status --porcelain -- dac-player/` — **5 file đang sửa dở, chưa commit:**
  `M dac-player/app/build.gradle.kts`, `M .../MainActivity.kt`,
  `M .../AuthManager.kt`, `M .../DacRenderersFactory.kt`,
  `M .../res/layout/activity_main.xml`.
  → Phase 0 KHÔNG đụng vào 5 file này. Phase 1 phải xem diff trước khi sửa tiếp (8b: kiểm tra thực tế trước khi làm).

## 9. iOS (thật)

- Chưa có thư mục `ios/`, chưa có file Swift nào, chưa có Xcode project.
  Bundle ID dự kiến theo plan: `one.lethanhdong.dacapp` — chưa đăng ký/verify.
  → Đúng trạng thái "Phase 3 chưa bắt đầu".

## 10. Những gì Phase 0 KHÔNG làm (theo plan)

- Không viết code tính năng mới. Không sửa 5 file đang dở. Không tạo user test.
  Không đụng data thật. Không deploy.

## 11. Lệch giữa plan chi tiết và thực tế (ghi rõ để Phase 1 không làm sai)

| # | Plan chi tiết viết | Thực tế (đã verify) | Hệ quả |
|---|---|---|---|
| 1 | Repo `dac-app/` với `android/`, `ios/`, `worker/` | Monorepo `english-lab/` với `dac-player/` + `worker/src/` | Docs Phase 0 đặt ở `dac-player/docs/`, không tạo `dac-app/` mới. |
| 2 | "Android project already exists with Media3 + decent-player (or will be verified)" | Có, nhưng còn Jellyfin GPL | Phase 1.5 bắt buộc, không được bỏ qua. |
| 3 | Worker "has at least basic /api/auth/* and /api/dac/*" | Có đầy đủ + rate-limit IP + OTP Resend + sessions | Phase 1.1/2.2/4.2 xây TRÊN cái đã có, không viết lại từ 0. |
| 4 | `android/app/libs/media3-ffmpeg-lgpl.aar` | Chưa có `libs/`, chưa có AAR | Phase 1.5 phải build workflow FFmpeg trước. |
| 5 | Version "always increases" — giả định bắt đầu từ 0 | Đã ở versionCode 2 / 0.2.0-dac-pass | Phase 1.6 tăng lên 3 / 0.3.0 (hoặc theo anh Chốt). |
| 6 | Drive scope "start with drive.file + drive.readonly" | Code chỉ dùng `drive.readonly` | Phase 2.1 test copy với `drive.readonly` trước, ghi lỗi thật rồi mới quyết scope. |
