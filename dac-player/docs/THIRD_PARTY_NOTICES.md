# Third-Party Notices — dac-app

This application uses the following open-source components.

> Nguồn: plan chi tiết dac-app § "Step 0.4 — Create license template" (skeleton gốc) +
> inventory thật Phase 0.2 (2026-10-13). Chỉ ghi những gì đã verify từ code / repo thật.
> Thư viện chưa thêm vào code thì ghi "(chưa thêm — Phase X)" để không bịa là đã dùng.
> Cập nhật commit hash / version mỗi khi thêm hoặc nâng cấp thư viện.

## FFmpeg
- License: LGPL v2.1 or later
- Source: https://git.ffmpeg.org/ffmpeg.git
- Commit: `b37bf81a7a9782438e4fe06a249329e279694494` (branch `release/6.0`, verify 2026-10-14 từ `build-hashes.txt` của CI run #1 workflow "Build FFmpeg LGPL AAR")
- AAR: `app/libs/media3-ffmpeg-lgpl.aar` — build từ androidx/media tag `1.9.3` (commit `9b8b13d177cf9a3ce997773ca51337acf5acc639`), NDK `27.1.12297006`, SHA-256 `6c47cd7f9c7a29f7f534a8010b9c7775ff31a901999273fe5fe4a95133359a0f`
- Used for: Audio decoding (APE, ALAC, etc.)
- **Trạng thái (2026-10-14): ĐÃ thay thế Jellyfin GPL.** AAR FFmpeg LGPL tự build, không `--enable-gpl` (CI guard chặn). Xem mục "Jellyfin" bên dưới (đã xoá khỏi code).

## decent-player / decent-usb-audio-driver
- License: MIT
- Source: https://github.com/Ma145/decent-player
- Commit (CI pin, đã verify trong `.github/workflows/build-dac-apk.yml`): `d039f9d6b1ec30901a5cd6edf72c29cde362a549`
- Used for: Bit-perfect USB Audio Class 2.0 output on Android
- Modules dùng (qua composite build, sparse-checkout chỉ `libs/`):
  - `decent-usb-audio-driver`
  - `decent-usb-audio-wrapper-media3`
  - `decent-media3-decoder-flac`
- KHÔNG dùng: `driver/Felicity/` (AGPL-3.0) — đã loại, không checkout.

## AndroidX Media3 (ExoPlayer)
- License: Apache 2.0
- Version (đã verify `gradle/libs.versions.toml`): 1.9.3
- Used for: Playback framework

## libFLAC
- License: BSD
- Used for: FLAC decoding
- Ghi chú: dùng qua `decent-media3-decoder-flac` (decode FLAC ra integer thô tại extractor).
  Nếu FFmpeg xử lý FLAC (khi chưa có libFLAC) thì decode ra float32, driver chuyển ngược bằng x·2^N.

## AndroidX / Kotlin (đã có trong code)
- License: Apache 2.0
- Versions (đã verify `gradle/libs.versions.toml`):
  - core-ktx 1.18.0, appcompat 1.7.1, recyclerview 1.4.0, lifecycle-runtime-ktx 2.9.2
  - kotlinx-coroutines-android 1.10.2, Kotlin 2.2.20, AGP 9.1.0
- Used for: UI components, async programming

## Coil / OkHttp / kotlinx.serialization / Room / Hilt / WorkManager / etc.
(fill as libraries are added)

- Coil 2.7.0 — Load ảnh bìa album — Apache 2.0 — **đã thêm (Phase 1.4, CI run #66)**
- OkHttp 4.12.0 — Networking, thay HttpURLConnection — Apache 2.0 — **đã thêm (Phase 1.4, CI run #66)**
- kotlinx.serialization-json 1.7.3 — Parse JSON, thay org.json — Apache 2.0 — **đã thêm (Phase 1.4, CI run #66)**
- MediaMetadataRetriever — Đọc metadata (Android SDK, không cần dependency) — **đã dùng (Phase 1.4, CI run #66)**
- Room 2.6.1 (+ room-ktx) — Cache thư viện nhạc — Apache 2.0 — **chưa thêm (Phase 2.3)**
- Hilt 2.52 — Dependency injection — Apache 2.0 — **chưa thêm (Phase 2.3)**
- WorkManager 2.9.1 — Background copy/sync — Apache 2.0 — **chưa thêm (Phase 2.3)**
- jaudiotagger 3.0.1 (hoặc bản Apache mới nhất lúc thêm) — Đọc/ghi tags — Apache 2.0 — **chưa thêm (Phase 2.3)**

## iOS components (Phase 3 — chưa bắt đầu)
- Kingfisher (MIT) — Load ảnh bìa — **chưa thêm**
- Google Sign-In SDK (Apache 2.0) — Drive auth iOS — **chưa thêm**
- URLSession (Apple, built-in) — Networking — **chưa thêm**
- Codable (Apple, built-in) — Parse JSON — **chưa thêm**
- AVFoundation (Apple, built-in) — Playback + metadata — **chưa thêm**
- CoreAudio (Apple, built-in) — DAC output — **chưa thêm**

## Jellyfin FFmpeg decoder (ĐÃ LOẠI — đã xoá khỏi code ở Phase 1.5, CẤM dùng lại)
- License: GPL-3.0 — **không được dùng trong app đóng**
- Đã xoá 2026-10-14: `implementation(libs.media3.ffmpeg.decoder)` trong `app/build.gradle.kts` + entry `media3-ffmpeg-decoder` trong `gradle/libs.versions.toml`.
- Thay bằng: AAR FFmpeg LGPL tự build (xem mục FFmpeg ở trên).

## Nghĩa vụ LGPL (khi Phase 1.5 xong)
- Cung cấp source FFmpeg: link tới git.ffmpeg.org + ghi commit hash trong repo.
- Ghi license: file này trong app (Settings → About → Open Source Licenses).
- Cho phép thay thế lib: AAR chứa FFmpeg dưới dạng `.so` riêng (dynamic link).
- Không sửa FFmpeg: dùng nguyên bản, không patch. Nếu có patch → phải công khai patch.
