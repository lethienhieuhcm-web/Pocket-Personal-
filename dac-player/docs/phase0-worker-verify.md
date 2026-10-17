# Phase 0.3 — Verify Worker API live (bằng request thật)

**Ngày kiểm tra:** 2026-10-13, ~16:52 giờ VN (09:52 UTC)
**Base URL:** `https://lethanhdong.one` (Worker Pocket Personal — đã live, `X-Build-Id: 20261013073003` trên `/dac`)
**User-Agent dùng cho mọi request:** `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36`
(Lý do: Cloudflare trả 403 cho UA Python-urllib — bài học cũ trong AGENTS.md.)

## 0. Nguyên tắc khi verify (8b — không động data thật)

- **KHÔNG tạo user test** bằng `POST /api/auth/register` với email hợp lệ trong Phase 0.
  Lý do: register thành công sẽ tạo user thật trong DB mà Phase 0 không có cơ chế xoá sạch
  (không có endpoint admin delete-user cho test). Tạo rồi bỏ đó = rác data — vi phạm 8b.
- Thay vào đó, Phase 0 dùng **probe không đột biến** (non-mutating):
  `GET /` + `GET /dac` (đọc), `POST /login` với email không tồn tại (401, không tạo gì),
  `GET /api/dac/music` + `GET /api/auth/me` không token (401),
  `POST /register` với email sai định dạng (400, validate chặn trước khi tạo user).
- Luồng register thành công + login sai 5 lần + đo timing sẽ làm ở **Phase 1.1**,
  với tài khoản test riêng + dọn sạch ngay sau test (đúng quy trình "test bug").
- Tổng số request login trong Phase 0: **1 lần** (dưới ngưỡng 10/phút/IP của rate-limit hiện có).

## 1. GET / — trang chủ live

```
GET https://lethanhdong.one/
→ HTTP 200 OK
→ Content-Type: text/html
→ Cache-Control: public, max-age=0, must-revalidate
→ CF-Cache-Status: HIT
→ Body chứa: <title>Pocket Personal — Bộ công cụ cá nhân</title>
→ Body chứa build nhúng: var B="20261013073003"
```

Kết luận: Worker live, trang chủ trả 200.

## 2. GET /dac — trang tải DAC live

```
GET https://lethanhdong.one/dac
→ HTTP 200 OK
→ Content-Type: text/html
→ X-Build-Id: 20261013073003
→ Cache-Control: no-store
→ Body chứa: <title>DAC Pocket — Tải APK</title>
```

Kết luận: route `/dac` → serve `/english/dac.html` (khớp `index.js:299`). Build ID khớp `/`.

## 3. POST /api/auth/login — email không tồn tại (probe, không tạo gì)

Request:

```bash
curl -s -i -A "<UA>" -X POST https://lethanhdong.one/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"phase0-nonexistent-1760360000@example.com","password":"wrong-wrong-wrong"}'
```

Response (nguyên văn):

```
HTTP 401 Unauthorized
Content-Type: application/json
Content-Length: 31

{"error":"Invalid credentials"}
```

Kết luận:
- Endpoint login live, trả 401 đúng cho email không tồn tại.
- **Chưa đo timing** ở Phase 0 (cần 2 tài khoản test: tồn tại vs không tồn tại, mỗi bên 10 lần,
  so sánh trung bình — làm ở Phase 1.1). Từ code (`auth.js handleLogin`): khi user không tồn tại,
  hàm return 401 NGAY, không chạy PBKDF2 → **timing leak còn tồn tại**, Phase 1.1 phải fix.

## 4. GET /api/dac/music — không token

```
GET https://lethanhdong.one/api/dac/music (không header Authorization)
→ HTTP 401 Unauthorized
→ {"error":"Not logged in"}
```

Kết luận: gate auth hoạt động — không token → 401, không lộ danh sách nhạc.

## 5. GET /api/auth/me — không token

```
GET https://lethanhdong.one/api/auth/me (không header Authorization)
→ HTTP 401 Unauthorized
→ {"error":"Not logged in"}
```

Kết luận: endpoint `/api/auth/me` live, gate auth đúng.

## 6. POST /api/auth/register — email sai định dạng (400, không tạo user)

Request:

```bash
curl -s -i -A "<UA>" -X POST https://lethanhdong.one/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"not-an-email","password":"TestPass123!"}'
```

Response (nguyên văn):

```
HTTP 400 Bad Request
Content-Type: application/json
Content-Length: 39

{"error":"Enter a valid email address"}
```

Kết luận: validate email chạy trước khi tạo user (khớp code `auth.js handleRegister`:
`EMAIL_RE` check → 400). Probe này không tạo user.

## 7. Rate limiting — đã có gì (đọc code + verify gián tiếp)

Code thật trong `worker/src/index.js` (đã đọc trực tiếp):

```js
const RATE_LIMITS = {
  "/api/auth/login": [10, 60],       // 10 logins/min per IP
  "/api/auth/register": [5, 3600],    // 5 registers/hour per IP
  "/api/auth/send-code": [3, 3600],   // 3 codes/hour per IP
  "/api/auth/verify-code": [10, 60],  // 10 verifies/min per IP
  "/api/analytics": [30, 60],
  "/api/tts": [20, 60],
  "/api/browse": [100, 60],
};
```

- Cơ chế: bảng D1 `rate_limits` (ip, endpoint, windowStart, count), `onConflictDoUpdate` tăng count,
  vượt ngưỡng → `429 {"error":"Too many requests. Please try again later."}` + header `Retry-After`.
  Fail-open nếu check lỗi (cho request qua để không sập availability).
- **Chưa test 429 thật ở Phase 0** (cần 11 request login trong 1 phút — cố tình spam rate-limit
  chỉ để test là không cần thiết ở Phase 0; test này thuộc Phase 1.1 với tài khoản test riêng).
- **Khác plan:** plan 1.1 yêu cầu giới hạn theo (IP + email) + khoá 15 phút sau 5 lần sai +
  timing equalization. Lớp IP-based hiện có KHÔNG thay thế được lớp per-(IP+email) này
  (attacker đổi email là né được IP-limit nếu chỉ tính tổng; và IP-limit đếm cả login đúng).
  → Phase 1.1 phải THÊM lớp per-(IP+email) + timing, GIỮ NGUYÊN lớp IP-based.

## 8. /dac live — SHA256 + APK (verify theo 8b: không tin chữ trên trang)

Trên trang `/dac` (đọc trực tiếp lúc 16:52 VN):

- Version hiển thị: `0.2.0-dac-pass • Build 13/10/2026`
- SHA256 hiển thị: `c756ef0e0bf0b33cd27994fec1eb9ecbaf18993011db86d995d623cd5d372b63`
- Link GitHub run: `https://github.com/lethienhieuhcm-web/Pocket-Personal-/actions/runs/38362585706`
- Link tải: `/dac-player-debug.apk` (trang ghi "21 MB")

Verify tải thật: đã chạy `curl → /tmp/dac-live-check.apk → sha256sum → grep strings`
trong lúc làm Phase 0 (xem ghi chú bên dưới). File `/tmp` đã xoá sau khi check.

**Kết quả verify APK live (bổ sung sau khi lệnh tải chạy xong — xem mục 8a):**

### 8a. Kết quả verify APK live (tải thật 2026-10-13 ~16:53 VN)

```
GET /dac → version 0.2.0-dac-pass, SHA256 trên trang:
  c756ef0e0bf0b33cd27994fec1eb9ecbaf18993011db86d995d623cd5d372b63
  link GitHub run: actions/runs/38362585706
HEAD /dac-player-debug.apk → HTTP 200, Content-Type: application/vnd.android.package-archive,
  Cache-Control: public, max-age=0, must-revalidate
Tải về /tmp/dac-live-check.apk → 21M
sha256sum → c756ef0e0bf0b33cd27994fec1eb9ecbaf18993011db86d995d623cd5d372b63
  → KHỚP 100% với SHA trên trang /dac. Trang trung thực.
unzip -l | grep -i jellyfin → "(no jellyfin entry)"
  → Chỉ là check tên file trong APK, KHÔNG chứng minh không có code Jellyfin.
  Code vẫn khai báo dependency Jellyfin GPL (xem inventory §5) → Phase 1.5 vẫn bắt buộc.
  Check đúng gốc ở Phase 1.5 phải là dex dump / grep class org/jellyfin, không phải unzip -l.
strings | grep -c "X-Drive-Token" → 1
  → APK chứa chuỗi X-Drive-Token (đúng dac-pass).
strings | grep -o "0.2.0-dac-pass" → (không hit)
  → Chuỗi version không tìm thấy bằng `strings` thuần (version nằm trong binary XML /
  manifest đã biên dịch, không phải chuỗi plain). Không kết luận version sai từ check này;
  version hiển thị trong app đã verify riêng ở build #27 (xem MEMORY).
File /tmp đã xoá sau khi check.
```

## 9. Những gì Phase 0.3 KHÔNG làm

- Không register user test (tránh rác DB).
- Không spam login để chạm 429 (tránh đốt quota rate-limit + log rác).
- Không gọi `/api/dac/*` với token thật của anh (không dùng token/session thật — 8b).
- Không gọi Drive API thật (cần Drive token của user — không tự lấy).

## 10. Kết luận Phase 0.3

- Worker live, build `20261013073003`, 5/5 probe non-mutating trả đúng status/body.
- Auth gate (401) đúng ở `/api/dac/music` và `/api/auth/me`.
- Register validate đúng (400 cho email sai).
- Rate-limit IP-based đã có; per-(IP+email) + timing equalization CHƯA có → Phase 1.1.
