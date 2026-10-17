# P1 — Web DAC phát nhạc bằng cách gọi Google trực tiếp từ browser

Trạng thái: BẢN THẢO — chờ anh Chốt mới code (8b). Không đụng code trước Chốt.

## 1. Vì sao hướng này (đã verify, không bịa)

- **403 đã đo thật** (2026-10-16, build 20261016031508): Worker → Google `alt=media`
  trả 403. Khớp bài học 10/10: IP-level block của Google với egress IP Cloudflare
  (cùng họ vụ Worker→Gemini).
- **Kết quả đào 3 repo** (tunecamp, mihonban, cloudstream — đọc code thật, 2026-10-16):
  không repo nào "fix" 403 bằng code; họ né bằng kiến trúc.
  cloudstream (gần nhất với sản phẩm của anh): **browser fetch Google trực tiếp bằng
  Bearer header → blob() → URL.createObjectURL → gán vào `<audio>`**.
  Request đi bằng IP của user → né IP block triệt để, không cần VPS gateway cho web.
- Lần fetch→blob trước đây của mình **sai ở chỗ**: fetch từ *proxy của mình*
  (vẫn là đường bị block), chưa bao giờ để browser gọi thẳng Google.

## 2. Hiện trạng code (grounded, đã đọc)

- `dacplayer.html:457`: `audio.src = '/api/dac/audio/'+id+'?token='+token` — đi qua
  Worker proxy = đường chết (403 ở tầng Worker→Google).
- `worker/src/dac.js:29-63`: `getDriveToken(request, env, email)` đã có sẵn
  refresh OAuth2 + buffer 60s trước hết hạn (đúng pattern refresh-token hygiene
  của tunecamp) — dùng lại, không viết mới.
- `dacplayer.html:127-128`: `getDriveToken()/setDriveToken()` đọc/ghi
  `sessionStorage['dac_drive_token']` nhưng **không chỗ nào gọi `setDriveToken`**
  → browser hiện không có Drive access token. P1 phải cấp token cho browser.
- `/api/dac/audio-sign` (`dac.js:259-271`): hiện chỉ "tạm trả URL proxy để test",
  chưa sign thật — không dùng cho P1.

## 3. Việc làm trong P1 (chỉ web, một việc một lúc)

**3.1. Worker — endpoint cấp access token ngắn hạn (1 việc duy nhất phía backend)**

- Thêm route `GET /api/dac/drive-token` (auth `'user'`, đặt cạnh các route
  `/api/dac/*` trong `worker/src/index.js:95-112`).
- Handler: `getSession` → `s.email` → gọi `getDriveToken(req, env, s.email)`
  (hàm đã có, tự refresh khi hết hạn) → trả `{access_token, expires_in}`.
- **Không bao giờ lộ refresh_token** ra browser. Access token ~1h, per-user,
  cùng mức trust với thiết kế `X-Drive-Token` đã Chốt (dac-pass); scope
  `drive.readonly` như hiện tại.

**3.2. Web `dacplayer.html` — 1 helper + 2 chỗ gọi**

- Hàm mới `driveAudioUrl(fileId)`:
  1. Lấy Drive access token: ưu tiên cache trong memory, fallback
     `sessionStorage['dac_drive_token']` kèm expiry; hết hạn → gọi
     `/api/dac/drive-token` (kèm `Authorization: Bearer <elab token>`) rồi lưu lại.
  2. `fetch('https://www.googleapis.com/drive/v3/files/'+fileId+'?alt=media',
     {headers:{'Authorization':'Bearer '+dat}})`.
  3. `401` → refresh token 1 lần, retry đúng 1 lần (pattern mihonban).
     `403` → **không retry** (retry chỉ tốn quota), báo lỗi thật kèm status.
  4. `!r.ok` → throw kèm status + content-type đo được.
  5. `const blob = await r.blob()` → `URL.createObjectURL(blob)` → trả URL;
     **revoke object URL cũ** khi đổi bài (tránh rò rỉ RAM).
- `playTrack` (dòng 444-479): thay dòng 457 thành
  `audio.src = await driveAudioUrl(currentTrack.id)`. Giữ nguyên try/catch
  và auto-test hiện tại.
- `prefetchNext` (dòng 507-516): dùng chung `driveAudioUrl` cho bài tiếp theo
  (1 code path, không 2 cơ chế). Nếu muốn scope nhỏ nhất: giữ prefetch cũ
  trong P1, đổi sau — quyết khi Chốt.

**3.3. Fallback**

- Nếu direct fail (CORS/network) → fallback về `/api/dac/audio` proxy hiện tại.
  Giữ nguyên code proxy, không xóa cho đến khi P1 pass live.

## 4. Test bug (8b.2) — verify bằng hành vi thật, không tin lý thuyết

- Browser thật mở `/dacplayer/`, bấm phát **1 file FLAC thật trên Drive của anh**
  (vd 1 track trong folder `ghosts_flac` đã verify đủ 42 file).
- Pass khi: không hiện errBox; `audio.duration > 0`; **tua được**
  (blob URL tua local luôn đúng); chuyển bài, prefetch bài tiếp OK.
- **Cửa ải CORS**: `drive.googleapis.com` phải trả `Access-Control-Allow-Origin`
  cho origin của mình — đo thật trong test. cloudstream làm được là bằng chứng
  tiền lệ, không thay thế lần đo của mình.
- Test thêm **1 file FLAC lớn (>100MB)** trên desktop để kiểm tra RAM blob;
  ghi nhận kết quả để quyết P2 (xem mục 6).

## 5. Không làm trong P1 (nói rõ để khỏi scope creep)

- Không đụng **native** (Android/iOS gửi Bearer trực tiếp tới Google — đường khác,
  test riêng).
- Không Range/progressive streaming: blob = giữ cả file trong RAM.
- Không gateway VPS (để dành P3).
- Không Navidrome/Subsonic — đã loại vì sai bản chất "nhạc của họ, không phải của anh".

## 6. Rủi ro đã nhìn thấy trước

- **RAM blob**: FLAC 24/96 có thể 100-200MB/file. Desktop OK; **điện thoại có thể
  bị browser evict** khi file quá lớn. Nếu test trên HONOR Play10 của anh fail
  → P2 (Range streaming thật) thành **bắt buộc**, không còn optional.
- CORS là cửa ải duy nhất chưa đo — nếu Google chặn origin lạ, P1 chết và phải
  quay lại hướng gateway VPS. Đo sớm nhất trong test.

## 7. Bảo mật

- Access token 1h nằm trong JS của session đã login — cùng mức trust với thiết kế
  đã Chốt. Refresh token không rời server (D1 `driveTokens`).

## 8. P2–P4 (chỉ sau khi P1 pass live)

- **P2**: Range streaming thật cho file lớn + điện thoại (fetch Range →
  MediaSource, hoặc chunked append); refresh hygiene đã có sẵn trong
  `getDriveToken` (buffer 60s).
- **P3**: signed ticket HMAC TTL 5 phút + media gateway trên VPS botkeep —
  **chỉ khi native cần** (native gửi Bearer trực tiếp nên có thể không cần).
- **P4**: MediaSession / lock-screen polish.

---
Soạn: 2026-10-16 ~11:55 +07 · Nguồn: code `dacplayer.html`, `worker/src/dac.js`,
`worker/src/index.js`, `worker/src/drive.js` (đọc trực tiếp); kết quả đào
tunecamp/mihonban/cloudstream trong side chat DAC 2026-10-16.
