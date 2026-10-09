# Kế hoạch đại tu Pocket Personal — v2 (2026-10-07)

Đã duyệt hướng lớn. Chưa code — chờ "Chốt" từng phase.

## Chẩn đoán hiện trạng
- **Backend:** `worker/src/index.js` là router khổng lồ bằng chuỗi `if` → đã gây 404 hàng loạt
  (handler viết xong quên đấu route) và lỗi TTS (mỗi route tự check auth riêng, vá sót).
- **Data:** R2 giữ users/sessions/bank (JSON), D1 giữ dữ liệu ăn theo email — xoá user không
  cascade, 2 mental model.
- **Frontend:** 7 trang, 3 kiểu tổ chức (ES modules / inline trong worker / static); mỗi trang
  tự viết fetch wrapper riêng (`apiCall`, `apiHeaders`, `elFetch`) → gốc của lỗi TTS.
- **Style:** design-system.css v2.0 (Tinh gọn) mới phủ ~70%.

## Kiến trúc mục tiêu
**Backend**
- Router khai báo: bảng route `{method, pattern, handler, auth: public|user|admin}` thay chuỗi `if`.
- Middleware `requireAuth`/`requireAdmin` bọc ngoài handler — vá 1 chỗ, áp dụng mọi route.
- `db/`: một lớp data-access duy nhất + `deleteUserCascade()`.
- Users/sessions: R2 JSON → D1 tables (single source of truth). R2 chỉ giữ blob lớn
  (bank mã hoá, MP3, PDF).
- Envelope chuẩn `{ok, data|error}`; route manifest tự sinh từ bảng route.

**Frontend**
- `js/core/` dùng chung mọi trang: 1 API client duy nhất (tự gắn auth header, tự xử lý 401).
- `/voice/`: tách HTML khỏi worker → `voice.html` như chess/music.
- Deploy script lint: trang mới không link design-system.css → báo lỗi.

**Style — thống nhất toàn bộ (v2, theo yêu cầu 2026-10-07):**
- Tất cả trang (english, stocks, voice, chess, music, hub, login, landing) dùng token Tinh gọn.
- **Music:** bỏ palette neon-dark riêng → về token chung (light mặc định + dark mode của hệ thống).
- **Landing:** làm lại theo style light Tinh gọn, đồng bộ với login/hub (thay bản dark v2).
- Không còn ngoại lệ style nào.

**Giữ nguyên:** Cloudflare Workers + D1/R2, vanilla JS (không framework), token thiết kế Tinh gọn.

## 6 phase (mỗi phase deploy độc lập)
1. **Router + middleware** — ✅ XONG 2026-10-07: 83 if-chains → bảng ROUTES khai báo +
   `dispatch()` với auth middleware (`user`/`admin`/`internal`/`custom`). Fix luôn bug live:
   `handleDriveMusic`/`handleDriveStream` chưa import → `/api/drive/music` 500.
   `/api/translate` chuyển sang yêu cầu đăng nhập (theo quyết định Henrry).
   E4: tạo `INTERNAL_SECRET` riêng, fallback `STOCK_PUBLISH_SECRET` để VM crons không gãy.
2. **Lớp db/ + cascade delete** — ✅ XONG 2026-10-07: `worker/src/db.js` mới — R2 helpers
   (users/sessions/bank), D1 helpers, `D1_USER_TABLES` (9 tables), `deleteUserCascade(env, email)`
   xoá R2 (user+bank+sessions, case-insensitive) + 9 tables D1, trả report. `handleAdminDelete`
   đã chuyển sang dùng. Test: stub Node (đúng logic, không chạm user khác) + SQL thật trên D1
   (insert test rows → 9 DELETEs → 0 còn lại, user thật nguyên vẹn).
3. **Migrate users/sessions → D1** — ✅ XONG 2026-10-07: tables `users`/`sessions` (blob JSON +
   index email/exp). `db.js`: D1 primary + R2 fallback + read-through backfill; dual-write mọi
   put. `auth.js`/`billing.js`/`drive.js`/`spotify.js` chuyển sang dùng `db.js`.
   `dbCountUsers`/`dbListUsers` xử lý đúng trạng thái pre-migration (không cấp nhầm admin).
   R2 fallback giữ 1 tuần rồi cắt (rollback = 1 dòng). `verify/` codes ở lại R2 (ephemeral).
   Test live: register/login/me/logout 200, D1 có đủ user+session, đã dọn test data.
4. **Frontend core thống nhất** — ✅ XONG 2026-10-07:
   - 1 `apiCall` duy nhất trong `js/core/api.js` (error contract `.status`/`.data`); xoá bản trùng
     trong `billing.js`; thêm `apiFetchRaw` cho blob.
   - Xoá `elFetch` — `tts.js` dùng `apiCall`/`apiFetchRaw` trực tiếp; `fetchDict` dùng
     `authHeaders()` chung.
   - **Fix critical bank**: `saveServerBank()` POST `{bank: payload}` (encrypted).
     Test round-trip thật: encrypt → POST 200 → GET → decrypt OK.
     Lưu ý: bank plaintext cũ trong R2 sẽ bị ghi đè bằng bản mã hoá ở lần save tiếp theo
     (tự lành); bank cũ load về [] như trước (không tệ hơn).
   - Tách `VOICE_HTML` khỏi worker → `voice.html` asset (E1 xong); repo không còn file chết.
5. **Thống nhất style toàn bộ** — ✅ XONG 2026-10-07: music bỏ neon-dark → Tinh gọn light;
   landing dark → light đồng bộ Hub/Login (giữ i18n VI/EN); thêm trang **Terms of Service**
   (`/terms`, đồng bộ Privacy); footer landing có link Privacy+Terms. Mọi trang đã dùng design-system.
6. **Verify ma trận** — ✅ XONG 2026-10-07: 81 API routes test live —
   58/58 user routes 401 khi không auth; 6/6 admin routes 401 không auth + 403 với token non-admin;
   6/6 internal 401 khi thiếu secret; 7/7 public 200; 4/4 OAuth callbacks không 500.
   10 trang chính đều 200. Test data đã dọn.

## Ghi chú
- Phase 3 là rủi ro chính (migrate user live). 5 user hiện tại, re-login là xong nếu sự cố.
- Không refactor lớn ngoài phạm vi 6 phase khi chưa được yêu cầu.
