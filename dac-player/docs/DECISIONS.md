# DECISIONS — dac-app (Decision log)

> Mọi quyết định kiến trúc đã Chốt. Đổi quyết định phải có quyết định mới rõ ràng từ anh,
> không tự đổi trong lúc code. Ghi ngày + nguồn (file / tin nhắn / commit) cho mỗi quyết định.

## Tên

- **Tên plan (codename): `dac-app`** — đã Chốt 2026-10-13 (file `~/workspace/english-lab/dac-app-plan.md`).
  Plan chi tiết upload ngày 2026-10-13 cũng mang tên `dac-app` → **không đặt tên mới**,
  giữ một tên duy nhất để tránh nhầm lẫn.
- **Tên hiển thị (app + web + tài liệu): "DAC Pocket"** — Chốt 2026-10-16. Lý do đổi từ
  "DAC Player": đã có app "DAC Player" của Own-It-Media (Digital Access Code, VOD)
  trên cả CH Play và App Store → trùng tên, nguy cơ nhầm lẫn/khiếu nại. Check trùng
  2026-10-16: không có app "DAC Pocket" nào trên 2 store.
- **Tên thư mục code Android: `dac-player/`** — là project thật, không đổi tên thư mục
  (đổi tên = sửa CI + đường dẫn + docs, rủi ro không đáng). `dac-app` = tên plan,
  `dac-player` = tên thư mục code Android, `dac-pass` = tên kiến trúc (bên dưới).
- **Không dùng bản copy `~/workspace/dac-player/`** (bản cũ, thiếu 3 file, khác 6 file).
  Chỉ làm việc trên `~/workspace/english-lab/dac-player/`.

## D1 — Native only (Chốt 2026-10-13, dac-app-plan.md §2)

- Native cho cả Android (Kotlin) và iOS (Swift). Không Flutter, không React Native, không KMP.
- Lý do: DAC không share được dù dùng framework nào (DAC + Audio Engine ~50% công sức,
  hoàn toàn khác nhau giữa Android và iOS). Học Spotify (Native), Shopify (bỏ RN 2026),
  Airbnb (bỏ RN 2018). Cross-platform chỉ share được UI + logic (~50%), nhưng phải trả giá
  app size, memory, viết lại Android.
- Backend dùng chung: Cloudflare Worker (Pocket Personal) + D1 + Resend.

## D2 — dac-pass: Worker là gate, không lưu Drive token (Chốt 2026-10-13, đã live)

- App lấy Drive token từ AccountManager (Android) / Google Sign-In (iOS), gửi lên Worker
  qua header `X-Drive-Token` mỗi request.
- Worker verify session Pocket Personal + gọi Drive API (passthrough), KHÔNG lưu Drive token.
- App stream trực tiếp từ Google Drive, Worker không chạm vào bytes.
- Đã xoá `/api/dac/upload` + `/api/dac/copy` (R2 không còn cần cho nhạc).
- Chấp nhận: stream URL bearer ~1h (chỉ file của chính user); `drive.readonly` đọc toàn bộ
  Drive (giảm thiểu: `files.list` filter audio).
- Lỗ hổng share APK (decompile, xoá check login → app chạy độc lập) nên loại phương án
  direct không server gate. Worker là gate duy nhất: không session → 401.

## D3 — Không GPL / AGPL (Chốt 2026-10-13)

- Chỉ dùng thư viện MIT / Apache 2.0 / BSD / LGPL. Cấm GPL / AGPL trong app đóng.
- Đã loại: `driver/Felicity/` (AGPL-3.0), NewPipe Extractor (AGPL), librespot, TarsosDSP (GPL).
- **Còn tồn đọng (phải fix ở Phase 1.5):** Jellyfin FFmpeg decoder (GPL-3.0,
  `org.jellyfin.media3:media3-ffmpeg-decoder:1.9.0+1`) vẫn còn trong code.
  Thay bằng FFmpeg LGPL tự build (Media3 1.9.3 + FFmpeg release/6.0, không `--enable-gpl`).
  Cấm ship bản thương mại khi còn Jellyfin.

## D4 — iOS bit-perfect: best-effort, nói thật (Chốt 2026-10-13)

- Android = true bit-perfect (decent-player bypass hoàn toàn AudioFlinger).
- iOS = best-effort gần bit-perfect (AVAudioSession, set `preferredSampleRate` = sample rate file,
  volume 100%, không EQ, không processing). iOS không có true bypass.
- Ghi rõ trong UI + About: "On iOS, sample rate switching is best-effort. True bit-perfect
  exclusive mode is available on Android only." — không quảng cáo quá sự thật.

## D5 — Phân phối

- Android: APK miễn phí qua web `lethanhdong.one/dac` (không CH Play, tránh phí $25).
  Mỗi release: tăng versionCode/versionName, SHA256 + link GitHub run trên trang `/dac`,
  verify bằng cách tải APK live về + check SHA + grep DEX.
- iOS: sideload miễn phí trước (AltStore/Sideloadly, Apple ID free, app hết hạn 7 ngày),
  App Store/TestFlight sau ($99/năm) — khi nào sẵn sàng phân phối mới trả phí.

## D6 — Bảo mật (học Spotify, Chốt 2026-10-13)

- Rate limiting: giữ lớp IP-based đã có (login 10/phút/IP, register 5/giờ/IP) +
  THÊM lớp per-(IP+email) 5 lần sai/15 phút + khoá 15 phút (Phase 1.1).
- Timing equalization: luôn chạy PBKDF2 dù user không tồn tại (Phase 1.1).
  Hiện tại `handleLogin` return sớm khi không có user → timing leak (ghi nhận Phase 0.3).
- Token: EncryptedSharedPreferences (Android) / Keychain (iOS). Hiện tại Android còn plain text → Phase 1.2.
- Email verification + forgot-password qua Resend: làm ở Phase 2.2, tái dùng helper Resend
  đã có cho OTP (không viết lại). Register hiện tại chưa gửi email, chưa có `verified=false`.
- Session: 7 ngày hiện tại; Access (1h) + Refresh (30d) + rotation để Phase 4.1
  (cần refactor cả Worker + Android + iOS, làm sau khi 2 app ổn định).
- Session list/revoke backend ĐÃ có (`GET /api/auth/sessions`, `POST /api/auth/sessions/revoke`)
  → Phase 4.2 chỉ làm UI.

## D7 — Drive scope cho Copy (triển khai 2.1 xong 2026-10-14, CHỜ data thật để Chốt)

- Hiện tại code chỉ dùng `drive.readonly` (`DriveAuthManager.DRIVE_SCOPE`).
- 2.1 đã implement (Worker `POST /api/dac/copy` + app `DriveCopyManager`):
  thử `files.copy` server-side trước; nếu 403 → trả `{ error: 'insufficient_scope' }`
  + log chi tiết Drive error vào KV (`dac_copy_log/...`, TTL 30 ngày).
  App bắt `CopyScopeException` → hiện hướng dẫn cấp quyền lại, dừng copy.
- **Chưa Chốt**: cần user test copy file share thật trên máy thật.
  Khi có log 403 → quyết: xin scope `drive` full (cần Google verification)
  hay giữ `drive.readonly` + hướng dẫn user.
- Copy chỉ file audio, giới hạn 100 file/10GB/ngày, log mọi lần copy.
- Không dùng rclone. Drive API `files.copy` = server-side, ~30s cho 10GB (vs 80 phút download+upload).

## D8 — Phase 0: docs ở đâu (quyết trong lúc làm Phase 0, 2026-10-13)

- Plan chi tiết giả định repo `dac-app/` — thực tế không tồn tại.
  Quyết: docs Phase 0 đặt ở `dac-player/docs/` (project Android thật), không tạo `dac-app/` mới.
  Khi nào tách repo riêng cho dac-app thì dời docs theo, không để 2 bản.
- Phase 0 không tạo user test (tránh rác DB), dùng probe không đột biến để verify Worker.
  Register thành công + test 429 + đo timing làm ở Phase 1.1 với dọn sạch.

## D10 — Lock login: per-(email+fingerprint), bỏ IP khỏi key (Chốt C, 2026-10-13)

- Thay thế D6 phần "per-(IP+email)": lock sau 5 lần sai / 15 phút, key = email + fingerprint
  (UA + screen/tz/lang, hàm `makeFingerprint` đã có, VPN-proof), KHÔNG dùng IP.
- Lý do: IP xoay — sandbox mỗi request 1 IPv6 khác (đã chứng minh bằng D1: 3 request → 3 IP,
  mỗi IP count=1), user thật đổi WiFi/4G/CGNAT cũng xoay IP → per-(IP+email) không bao giờ đủ 5.
- Cột `ip` trong bảng D1 `rate_limits` lưu `fp:<fingerprint>` cho hàng `login-failed`
  (phân biệt với IP thật của hàng generic). Không tạo bảng mới, không migration.
- Fingerprint khác → đếm riêng (đã test: cùng email, FP khác → 401, không bị khoá oan).
  Attacker spoof fingerprint (cùng UA + fp body) vẫn có thể khoá victim — khó hơn per-email,
  lock chỉ 15 phút, chấp nhận.
- App Android cần gửi `fp` ở Phase 1.3 để fingerprint phân biệt thiết bị tốt nhất
  (hiện chỉ dựa UA khi không có `fp`). Web đã gửi `fp` từ trước.

## D9 — 8b áp dụng cho toàn bộ dac-app (Chốt theo RULES.md mục 8b)

- Suy nghĩ → list việc → anh Chốt rồi mới code. Một việc một lúc, test pass mới sang tiếp.
- Không bịa giá trị API ngoài — verify bằng request thật trước khi code.
- Deploy xong verify bằng hash/build-id trên live, không tin "DEPLOY OK" suông.
- Tự test bằng browser thật / thiết bị thật, không nhờ anh test.
- Dọn sạch data test sau mỗi lần test. Không dùng token/session thật của anh để test.
- UI mới đủ 4 ngôn ngữ, không popup/modal, không lộ công nghệ trong text user-facing.

## D11 — Recipe FFmpeg LGPL 1.5: Media3 1.9.3 + FFmpeg release/6.0 + NDK 27.1.12297006 (đính chính 2026-10-14)

- **Đang là cái gì (trước đính chính):** plan chi tiết Step 1.5 ghi Media3 tag 1.9.3 +
  FFmpeg release/6.0 + NDK r26b ("theo README ở tag 1.9.3"); `dac-app-plan.md` §8.3 ghi
  "Đã verify từ README ở tag 1.9.3: FFmpeg release/6.0, NDK r26b". Bản nháp hôm qua
  (theo recipe kroma) dùng Media3 tag **1.9.0** — SAI: kroma build cho Media3 1.9.0
  (`media3-decoder-ffmpeg-1.9.0.aar`), app mình chạy 1.9.3 → AAR 1.9.0 gắn vào sẽ
  `ffmpeg=false` mà không báo lỗi gì.
- **Đã verify bằng source thật (2026-10-14, đọc trực tiếp từ GitHub):**
  - `androidx/media` README ở tag 1.9.3: FFmpeg "We currently recommend version 6.0"
    → `release/6.0`; NDK "tested on r26b". README ở tag 1.9.0 ghi Y HỆT (r26b +
    release/6.0) — nên release/6.0 KHÔNG phải "chỉ cho 1.9.0", nhưng cũng không được
    mặc định mang từ recipe 1.9.0; phải đọc README ở đúng tag 1.9.3 — đã đọc, khớp.
  - `kromatv/kroma` (`packages/media3-ffmpeg/README.md`): Media3 1.9.0 + FFmpeg
    release/6.0 + NDK **27.1.12297006**; "Rebuild when the media3 runtime version
    moves (keep the two in step)"; proof duy nhất decoder được load là logcat
    `Loaded FfmpegAudioRenderer`.
  - `Silo-Server/silo-android` (`scripts/build-ffmpeg-aar.sh` + README): Media3
    1.11.0 + FFmpeg **n6.0** + NDK **r26d**; "n7.x breaks the JNI glue" → không lên
    n7.x; NDK ≤ r27 không tự align 16 KB → patch link
    `-Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384` + verify ELF header.
- **Chốt:** Media3 tag **1.9.3** + FFmpeg **release/6.0** + NDK **27.1.12297006**
  (1 NDK duy nhất, theo recipe kroma đã build thật). Ghi `git rev-parse HEAD` của cả
  Media3 và FFmpeg lúc build vào workflow log + THIRD_PARTY_NOTICES.md.

## D12 — Đăng nhập bằng Google: ID token + Credential Manager (plan 2026-10-14, Henrry yêu cầu)

- **Vấn đề:** web đã có Google login (authorization code flow), Android chưa có.
  User phải nhớ thêm 1 mật khẩu + verify email.
- **Học ông lớn:**
  - **Google Identity Services:** Android dùng **Credential Manager API**
    (chuẩn hiện tại), KHÔNG dùng `GoogleSignInClient` (deprecated).
    Credential Manager trả về **ID token (JWT)** — không phải auth code.
  - **Google server-side verification:** Worker verify chữ ký JWT qua JWKS
    (`https://www.googleapis.com/oauth2/v3/certs`), check `aud`/`iss`/`exp`.
    Không tin claim từ client, không cần `client_secret` trong app.
  - **Apple Sign In:** dùng `sub` làm ID ổn định (email có thể đổi).
    Lưu `google_sub` để login lần sau, không match bằng email.
  - **GitHub:** auto-link tài khoản khi email đã verify (`email_verified=true`).
  - **Nguyên tắc scope tối thiểu:** auth chỉ `openid email profile`;
    scope Drive xin riêng khi user bấm "Kết nối Drive".
- **Khác web:** web dùng code flow (cần `client_secret` ở server);
  Android dùng ID token (không secret trong app). Web match bằng email;
  Android lưu thêm `google_sub`.
- **Endpoint chung:** `POST /api/auth/google/idtoken` — Android (2.4) và
  iOS (3.2) dùng chung.
- **DB:** thêm `google_sub TEXT UNIQUE NULL`, `auth_provider TEXT DEFAULT 'password'`.
- App `libs.versions.toml` đã xác nhận Media3 runtime = 1.9.3.

### D12 bổ sung 2026-10-14 — parse credential đúng API chuẩn

- **Bug:** code cũ `if (credential is GoogleIdTokenCredential)` sai — kết quả
  của `GetGoogleIdOption` luôn là `CustomCredential` với
  `type = GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL`.
  Đúng: `GoogleIdTokenCredential.createFrom(credential.data).idToken`
  (verify từ docs Google + binary `googleid-1.1.1.aar` trên dl.google.com).
- **Worker:** base64url trong JWT không có padding — decode phải bù `=`
  cho đủ bội số 4 trước `atob` (đúng spec WHATWG), nếu không hành vi phụ thuộc
  runtime.
- **Lookup:** `sub` là định danh ổn định → lookup độc lập theo `google_sub`
  trước (qua `dbGetUserByGoogleSub`), rồi mới tới email; xử lý cả trường hợp
  user đổi email Google (migrate row sang key email mới).
- **Web client ID:** client Web app của lethanhdong.one — lấy từ flow OAuth live
  (redirect accounts.google.com khi bấm nút Google trên web, 2026-10-14), không
  bịa; cùng giá trị cho secret Worker `GOOGLE_WEB_CLIENT_ID` và BuildConfig
  Android (client ID là public trong OAuth URL).

## Lịch sử thay đổi decision log

- 2026-10-13: Tạo file (Phase 0.5). Ghi lại 9 quyết định đã Chốt từ `dac-app-plan.md` +
  plan chi tiết + code/worker thật. D7 vẫn mở, chờ test thật ở Phase 2.1.
- 2026-10-13: Thêm D10 — lock login đổi sang per-(email+fingerprint) (Chốt C).
  D6 phần per-(IP+email) bị thay thế bởi D10.
- 2026-10-14: Thêm D11 — đính chính recipe FFmpeg 1.5: Media3 1.9.3 (không phải 1.9.0
  theo recipe kroma) + FFmpeg release/6.0 (verify từ README ở đúng tag 1.9.3) +
  NDK 27.1.12297006 (CHỐT 1 NDK, theo kroma). Sửa NDK r26b → 27.1.12297006 ở cả
  plan chi tiết Step 1.5 và `dac-app-plan.md` §8.3.
- 2026-10-14: Thêm D12 — Đăng nhập bằng Google (plan Step 2.4, Henrry yêu cầu).
  Theo chuẩn big-tech: Android dùng ID token + Credential Manager (không phải
  authorization code flow như web, không giữ client_secret trong app); Worker verify
  chữ ký qua Google JWKS, check `aud`/`iss`/`exp`; dùng `sub` làm ID ổn định
  (lưu `google_sub`); auto-link khi `email_verified=true`; scope auth chỉ
  `openid email profile` (Drive xin riêng). Endpoint `POST /api/auth/google/idtoken`
  dùng chung cho Android (2.4) và iOS (3.2).
