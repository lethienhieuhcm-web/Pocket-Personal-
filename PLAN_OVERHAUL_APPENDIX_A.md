# Phụ lục A — Phân tích sâu kiến trúc (2026-10-07, chưa code)

Phân tích tĩnh trên code thật. Không suy đoán — mỗi điểm đều có vị trí file:dòng.

## A. Backend Worker (2.553 dòng, 83 API routes)

### A1. Router thủ công — rủi ro cấu trúc
`worker/src/index.js` (267 dòng) đấu route bằng chuỗi `if (pathname === ... && method === ...)`.
Bảng route là **implicit** — không có nơi nào liệt kê đầy đủ. Hệ quả đã xảy ra 2 lần trong ngày:
- 8 handler viết xong quên đấu route → 404 (sáng 07/10, đã vá)
- Vá TTS sót `elFetch` vì auth nằm rải rác (đã vá)

### A2. Auth thực thi bằng 3 cách khác nhau, không có middleware
1. `import { getSession } from './auth.js'` trực tiếp (một số handler)
2. `const {getSession} = await import('./auth.js')` — lazy import với comment
   "to avoid cycle" (`content.js:28,42`) → dấu hiệu **circular dependency** giữa modules
3. `checkFeature(request, env, ...)` từ `billing.js` (TTS, dict) — vừa auth vừa quota

Không có một điểm duy nhất để trả lời "route này cần quyền gì". Thêm route mới =
tự nhớ gắn auth = sẽ sót.

### A3. Kiểm kê endpoint public (đã verify tay từng handler)
| Endpoint | Auth | Đánh giá |
|---|---|---|
| `/api/auth/*` (login/register/...) | không (đúng) | OK |
| `/api/tts`, `/api/voices`, `/api/quota` | user (qua checkFeature/getSession) | OK (đã vá) |
| `/api/dict` | user (qua checkFeature) | OK |
| `/api/translate` POST | **không** — chỉ rate-limit IP 300/ngày | Proxy mở. Chi phí thấp (endpoint Google unofficial) nhưng bị lạm dụng được |
| `/api/analytics` POST | **không** — có cap (word slice 30, min(50,...)) | Spam được nhưng bị chặn trần. Chấp nhận được, cần ghi nhận chủ đích |
| `/api/insights` GET | không | Chủ đích public (chỉ aggregate, không raw) |
| `/api/books/shared` GET | không | Chủ đích public (sách chia sẻ) |
| `/api/internal/*` (5 routes) | `X-Internal-Secret` vs `STOCK_PUBLISH_SECRET` | OK — nhưng **chung 1 secret** cho publish + migrate + alert-done |

### A4. Response envelope không thống nhất
- Lỗi: thống nhất `{error: msg}` qua `jerr()` (192 chỗ dùng) — tốt.
- Thành công: **2 kiểu lẫn lộn** — `{ok:true, ...}` (14 chỗ: auth, books, library)
  vs raw JSON (`{voices}`, `{subscription}`, toàn bộ stock API...).
  Frontend phải đoán shape từng endpoint.

### A5. D1: SQL nằm rải rác, không có data layer
- 9 tables, **tất cả** có cột email — `watchlist, portfolio_txns, alerts, targets,
  pins, usage_daily, subscriptions, drive_tokens, spotify_tokens`.
- SQL viết inline trong 4 file (`stock.js`, `billing.js`, `drive.js`, `spotify.js`),
  qua `env.DB.prepare(...)` trực tiếp trong handler. Không có hàm dùng chung,
  không có migration/schema versioning.
- `handleAdminDelete` (`library.js:156`) chỉ xoá R2 (`users/`, `bank/`, sessions) —
  **9 tables D1 mồ côi** sau mỗi lần xoá user.
- Đã có tiền lệ migrate: `hMigrateR2ToD1` (`stock.js:841`, endpoint
  `/api/internal/migrate-r2-d1`) — nhưng chỉ migrate **stock data** (R2 `stock/users/`
  → D1), chưa đụng auth users.

## B. Frontend

### B1. `voice.html` trong repo là FILE CHẾT
- `/voice/` serve `VOICE_HTML` **inline trong `worker/src/index.js:9-141`**, không phải
  `voice.html` trong repo. Sửa `voice.html` không bao giờ lên live.
- Đây đúng là lớp bug đã từng xảy ra với chess/music (đã tách) — nhưng voice bị sót.
- Hệ quả thêm: bản inline **override token design-system** bằng palette kem ấm riêng
  (`--bg:#fdfbf7`, `index.js:13-14`) — trang voice thực tế KHÔNG theo Tinh gọn dù có
  link CSS. Và `?v=1791286992` hardcode trong worker source **không bao giờ được
  re-stamp** (deploy script chỉ stamp file HTML deploy, không stamp worker source).

### B2. Hai `apiCall` khác error contract
- `js/core/api.js:6` — throw `Error(j.error || "HTTP "+status)`, **không có `.status`**
- `js/features/billing.js:19` — throw Error có `.status`, `.data`
- Importers hiện tại dùng bản core. `getPlan()` trong billing.js dùng bản billing.
  Cùng tên, khác contract → bẫy cho người sửa sau.

### B3. Bốn fetch wrapper riêng lẻ
`apiCall` (core) | `apiCall` (billing) | `elFetch` (tts.js) | `fetchDict` (dict.js).
Mỗi cái tự gắn (hoặc quên gắn) auth header — `elFetch` đã gây sự cố hôm nay.

### B4. Ma trận trang (9 trang)
| Trang | ds-link | Thực tế |
|---|---|---|
| index.html (47KB) | có | OK, sprite đã dọn sạch |
| hub, login, stocks, chess, privacy | có | OK (login vừa đưa vào) |
| voice.html (repo) | có | **CHẾT** — live là bản inline (B1) |
| music.html | không | palette neon-dark riêng → phase 5 |
| landing.html | không | bản dark v2 → phase 5 làm lại light |

### B5. Điểm tốt (giữ lại khi đại tu)
- ES modules 21 files, phân tách core/features rõ ràng, lazy-load books.js tốt.
- i18n tập trung (`js/core/i18n.js`), 1 key `elab_uiLang` dùng chung toàn app.
- `js/core/router.js` switchTab tập trung, có guard null.

## C. Data stores
- **R2 `english-lab-auth`**: `users/` (credential+role+plan), `sessions/`, `bank/` (blob mã hoá).
- **R2 `DATA`**: `analytics/` (library.js), `stock/` (stock.js).
- **D1 `pocket-personal`**: 9 tables email-keyed (B-A5).
- Quan hệ: email là join key mềm giữa R2 và D1 — không có FK, không cascade.

## D. Đánh giá rủi ro các phase (bổ sung cho plan)
1. Router khai báo — rủi ro thấp, behavior giữ nguyên.
2. db/ + cascade — rủi ro thấp-trung bình; cần liệt kê đủ 9 tables + R2 prefixes.
3. Migrate users/sessions → D1 — **rủi ro cao nhất**: session live, password hash
   (portable, chỉ là string), dual-write rồi cắt. Rollback: giữ R2 read-fallback.
4. 1 API client + tách voice.html — rủi ro trung bình; voice inline có logic JS riêng
   (apiHeaders, quota) cần chuyển nguyên vẹn + test TTS lại end-to-end.
5. Style music/landing — rủi ro thấp, thuần UI.
6. Verify ma trận — 83 routes × 9 trang × roles.

## E. Việc phát hiện thêm khi phân tích sâu (chưa trong plan v2)
- E1: `voice.html` chết → ưu tiên cao, cho vào phase 4.
- E2: 2 `apiCall` trùng tên khác contract → gộp trong phase 4.
- E3: `/api/translate` public không auth → quyết định: giữ (rate-limit đủ) hay bắt login
  (đồng bộ với dict). Chờ anh quyết.
- E4: 5 route `/api/internal/*` chung 1 secret → tách secret riêng cho migrate (phase 1).
- E5: `handleAdminDelete` thiếu cascade D1 → phase 2.
