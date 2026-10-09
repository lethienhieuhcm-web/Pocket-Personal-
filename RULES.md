# Bộ quy tắc Pocket Personal

> Mọi việc frontend, backend, UI, layout đều phải tuân theo bộ quy tắc này.
> Muốn đổi quy tắc → bàn với anh và được "Chốt" mới áp dụng.

---

## 1. Ngôn ngữ & xưng hô
- Gọi người dùng là **anh**, trợ lý xưng **em**.
- Trả lời **tiếng Việt**, ngắn gọn, trực tiếp.
- Không dùng từ ngữ kỹ thuật với người dùng cuối.

## 2. Phong cách UI — Tinh gọn
- **Tinh gọn, trung tính, thích ứng.** Ưu tiên điện thoại trước — **Android và iPhone**,
  phải hiển thị tốt và thao tác mượt trên cả hai.
- Không dùng **popup/modal** cho bất kỳ tính năng nào. Thay bằng chuyển trang hoặc hiển thị inline.
- Không trang trí rườm rà. Mỗi màn hình chỉ giữ những gì người dùng cần.

## 3. Màu sắc
- **Trang hub là chuẩn màu duy nhất.** Mọi trang/app khác phải dùng đúng bảng màu của hub,
  không tự đặt màu riêng.
- Màu chủ đạo: **xanh lá `#0d9d6c`** (`--pp-accent`), hover `#0b7a56`.
- Nền `#f6f7f9`, thẻ trắng, chữ `#14181f`, chữ mờ `#6b7280`, viền `#e8ebf0`.
- **Không** mỗi app một màu. Toàn app chỉ một bảng màu.
- Mọi màu dùng token `--pp-*` trong `design-system.css`, không hardcode mã màu lẻ.

## 4. Logo & Icon
- **Icon trên trang hub là chuẩn duy nhất.** Mọi icon ở các trang khác phải theo đúng
  phong cách icon của hub, không tự vẽ kiểu riêng.
- Phong cách: **hình học tối giản, nét đan nhau, đơn sắc đen/trắng** (logo đã chốt mẫu nút thắt túi).
- Icon toàn app đồng bộ: nét đều, hình học, đơn sắc.
- **Không dùng emoji** làm icon trong UI. Dùng SVG nét đều hoặc icon đã vẽ.
- Nút "← Pocket Personal" về hub phải giống nhau ở mọi trang.

## 5. Nội dung hiển thị
- Nội dung viết cho người dùng **không được tiết lộ**:
  - **Công nghệ**: không nhắc Cloudflare, D1/R2, Worker, OAuth, mã hoá, PWA,
    tên engine (ElevenLabs, VieNeu, Kokoro...), tên dịch vụ bên thứ ba.
  - **Cách thức vận hành**: không giải thích app chạy thế nào, dữ liệu đi đâu, xử lý ra sao.
  - **Gói cước**: không hiện tên gói (Free/Admin...), không so sánh gói, không rủ nâng cấp.
  - **Cách hoạt động của app**: không mô tả luồng xử lý nội bộ, giới hạn kỹ thuật, kiến trúc.
- Chỉ mô tả ở mức người dùng hiểu: **làm được gì**, dùng thế nào. Hết.

## 6. Đa ngôn ngữ
- Toàn bộ app dùng **4 ngôn ngữ: VI / EN / 中文 / 한국어**, áp dụng cho mọi trang hiện tại
  và mọi trang/tính năng tích hợp thêm sau này — không trang nào được thiếu.
- Dùng chung key `elab_uiLang` trong localStorage.
- Pattern: `data-i18n` + dict I18N + nút chọn VI/EN/中文/한국어 (như trang policy).
- **Thêm UI mới phải thêm đủ key dịch cả 4 ngôn ngữ ngay** — thiếu key là lỗi,
  trang sẽ hiện sai ngôn ngữ (đã gặp: mục Upgrade thiếu key EN/中文/한국어).

## 7. Quy trình làm việc
- **Sửa UI phải đi kèm backend**: không chỉ sửa giao diện, phải kiểm tra và sửa
  code backend tương ứng cho khớp.
- **Content và backend phải đồng bộ**: trước khi sửa, kiểm tra xem nội dung hiển thị
  và backend có khớp nhau không; sửa thì sửa cả hai cho đồng bộ.
- **Suy nghĩ → list việc → hỏi anh**: trước khi làm, suy nghĩ kỹ, liệt kê các nhiệm vụ
  cần làm, trình anh duyệt rồi mới bắt đầu.
- Sửa/review code phải **chạy test thật**, không review suông.
- **Không bịa dữ liệu**: không lấy được thì ghi rõ, không đoán.
- Mỗi phase/vòng lớn phải chờ anh **"Chốt"** mới làm tiếp.
- **Không tự tạo cron** hay hành động nền khi chưa được duyệt.
- Sau mỗi việc chỉ liệt kê **việc mới phát sinh**, không lặp list cũ.
- Lệnh Termux: **mỗi lệnh một khối code riêng**.
- Alert đã gửi qua Telegram thì **không báo trùng** trong chat.

## 8. Kỹ thuật
- Một frontend API client dùng chung, không gọi fetch rời rạc mỗi nơi một kiểu.
- **Token đăng nhập `elab_authToken` lưu dạng chuỗi thường** trong localStorage —
  đọc bằng `localStorage.getItem("elab_authToken")`, KHÔNG `JSON.parse`.
  (Chỉ `elab_uiLang` mới JSON-encode.) Parse nhầm → token null → trang tưởng chưa đăng nhập.
- API cần đăng nhập phải trả 401 khi thiếu token; admin API trả 403 cho user thường.
- Dữ liệu user là D1-primary; R2 chỉ là fallback có thời hạn.
- Xoá tài khoản phải xoá hết dữ liệu liên quan (cascade), nhưng chỉ làm khi đã harden.
- Deploy xong phải **verify live thật** (curl/check), không tuyên bố xong khi chưa kiểm tra.
- **Lỗi lặp lại thì sửa bằng code phía mình, không đổ cho trình duyệt.** Khi user báo lỗi
  xảy ra nhiều lần (cache cũ, session hết hạn, API fail...), phải viết code tự xử lý:
  tự phát hiện bản cũ và reload, mặc định về trạng thái an toàn nhất khi không lấy được
  dữ liệu (fail-closed), bọc try/catch từng bước khởi tạo để một lỗi không chặn cả app.
- HTML luôn trả `Cache-Control: no-cache, must-revalidate` + header `X-Build-Id` (worker tự thêm).
  Mỗi trang HTML có script tự kiểm tra: so `__BUILD__` nhúng trong trang với `X-Build-Id` live
  (qua HEAD request bypass cache) — lệch là tự `location.reload()`. User không bao giờ phải
  xoá cache tay sau deploy, kể cả khi đang test liên tục.
- **Script tự kiểm tra bản mới KHÔNG được chạy trong lúc trang đang load.** Phải chờ
  `window.load` + delay 2s mới kiểm tra, dùng HEAD request nhẹ. Chạy sớm sẽ giành tài nguyên
  với quá trình vẽ trang, gây lỗi layout (trang hiện nhỏ xíu) trên điện thoại.

## 8b. Quy trình sửa code (chống lỗi do chính mình gây ra)
- **Một lần chỉ sửa một lỗi.** Sửa xong → test → pass mới sửa lỗi tiếp theo.
  Không sửa 5-7 lỗi cùng lúc rồi deploy một thể.
- **Cấm replace hàng loạt bằng regex khi chưa đọc từng chỗ.** Mỗi lần replace phải
  đọc lại đoạn code sau khi sửa, chạy `node --check` ngay.
- **Không nhúng JS phức tạp vào thuộc tính HTML** (onclick="..."). Dễ sai escape
  (Python → JS → HTML), khó đọc, khó debug. Dùng `<script>` riêng + `addEventListener`.
- **Không tối ưu khi app chưa chạy ổn định.** Cấm code splitting, lazy-load, refactor lớn
  khi còn bug chưa sửa xong. Ưu tiên: app chạy đúng trước, nhanh sau.
- **Sửa gốc, không vá tạm.** Không thêm inline handler/script để lách qua lỗi module.
  Nếu module gãy thì tìm nguyên nhân module gãy và sửa nó.
- **Sau mỗi lần sửa file JS:** chạy `node --check` file đó. Sau mỗi lần sửa HTML:
  mở file kiểm tra đoạn vừa sửa bằng mắt thường.
- **Deploy xong phải test live ngay** đúng chức năng vừa sửa, không đợi dồn nhiều việc.
- **Tự test bằng browser thật, không nhờ user test** (thêm 2026-10-09). Có browser task thì tự mở trang, kiểm tra console, bấm thử chức năng. Chỉ nhờ anh test khi đã tự test kỹ mà vẫn không tái hiện được lỗi, hoặc cần thiết bị thật của anh.

## 8b-2. Cache busting chuẩn big tech (thêm 2026-10-09)
- **JS/CSS dùng filename hashing** (`foo.a1b2c3.js`), không dùng `?v=timestamp`.
  Hash = 8 ký tự đầu SHA-256 của nội dung. File đổi → tên đổi → browser tải mới.
- **Dependency cascade:** A import B, B đổi → A cũng phải đổi tên (vì nội dung A
  chứa tên mới của B). Dùng iterative refinement trong build.
- **SW không cache HTML.** HTML luôn đi network, browser xử lý theo Cache-Control.
- **SW update → hiện banner, không tự reload.** User đang nhập liệu mà reload
  mất dữ liệu là lỗi UX nghiêm trọng. Banner phải đủ 4 ngôn ngữ, dùng inline div
  (không popup/modal), style bằng token `--pp-*`.
- **SW update pattern chuẩn (sửa 2026-10-09, sau vụ loop):**
  - SW **KHÔNG** gọi `skipWaiting()` trong `install`. Để SW mới ở trạng thái "waiting".
  - SW lắng nghe message `SKIP_WAITING` → mới gọi `self.skipWaiting()`.
  - Client **KHÔNG** gọi `r.update()` mỗi lần load. Dùng `updatefound` event:
    khi SW mới ở trạng thái `installed` và đã có controller cũ → hiện banner.
  - User bấm "Cập nhật" → `newWorker.postMessage({type:"SKIP_WAITING"})` → reload.
  - User bấm "Để sau" → ẩn banner, SW vẫn waiting, không loop.
  - Lý do: gọi `skipWaiting()` ngay + `r.update()` mỗi lần load gây loop tải lại liên tục.
- **Giữ `__BUILD__` cho SW files** (không hash) để đảm bảo SW update đáng tin cậy.
- **Sinh `asset-manifest.json`** mỗi deploy để debug mapping tên cũ → tên mới.
- Tham khảo: Facebook/Google/Vercel đều dùng cách này.

## 8b-3. Tích hợp app mới vào Pocket Personal (thêm 2026-10-09)
Khi thêm app mới (ví dụ: app thứ 6, thứ 7...), phải làm theo checklist:
- [ ] Tạo HTML với I18N đủ 4 ngôn ngữ (VI/EN/中文/한국어), key `update_available`,
      `update_btn`, `update_later` bắt buộc có
- [ ] Đăng ký SW: KHÔNG gọi `r.update()` mỗi lần load — browser tự check update
      theo chu kỳ điều hướng. Cấm `r.update()` trong code load trang (nguyên nhân
      gây check update quá aggressive, đã gây loop tải lại 2026-10-09)
- [ ] Lắng nghe event `updatefound` trên `reg`: lấy `reg.installing`, theo dõi
      `statechange` → khi state = `installed` VÀ `navigator.serviceWorker.controller`
      tồn tại (tức có SW cũ đang điều khiển) → gọi `showUpdateBanner(newWorker)`.
      KHÔNG dùng message `SW_UPDATED` từ SW (pattern cũ, nguyên nhân gây loop)
- [ ] Copy hàm `showUpdateBanner()` chuẩn (dùng `createElement`, không inline HTML,
      style bằng `--pp-*`, không popup/modal)
- [ ] Tạo SW file riêng với scope đúng (ví dụ: `/newapp/sw.js`, scope `/newapp/`)
- [ ] SW không intercept HTML (`if (isPage) return;`)
- [ ] SW `install`: KHÔNG gọi `skipWaiting()` — để SW mới ở trạng thái `waiting`
      cho đến khi user bấm "Cập nhật". Thêm handler `message`: nhận
      `{type:"SKIP_WAITING"}` → gọi `self.skipWaiting()`
- [ ] Nút "Cập nhật" trong banner: `newWorker.postMessage({type:"SKIP_WAITING"})`
      rồi `location.reload()` — user chủ động chọn thời điểm update, không tự reload
- [ ] Thêm app vào `cf_deploy.py` nếu cần (FILES, manifest, PWA_MAP)
- [ ] Test: deploy → mở app → deploy bản mới → banner hiện → bấm Cập nhật → reload đúng

## 8b-4. Pattern "Có bản mới" chuẩn big tech (thêm 2026-10-09)
Áp dụng cho cả 5 app hiện tại: stocks, chess, music, hub, english (index).
- **Luồng:** SW mới install xong → ở trạng thái `waiting` (không activate ngay).
  Client phát hiện qua `updatefound` → hiện banner inline. User bấm "Cập nhật" →
  gửi `SKIP_WAITING` → SW activate → reload 1 lần. Bấm "Để sau" → đóng banner,
  SW mới vẫn `waiting`, lần mở trang sau vẫn có thể update.
- **Cấm tuyệt đối 2 thứ từng gây loop tải lại liên tục (2026-10-09):**
  (1) `skipWaiting()` trong `install` — SW mới activate ngay, gửi message ngay;
  (2) `r.update()` mỗi lần load — check update quá aggressive. Hai thứ cộng lại
  = vòng lặp down về liên tục, user báo "down về".
- **Banner:** inline `div` fixed top (`createElement`, không popup/modal),
  nút "Cập nhật" + "Để sau", đủ 4 ngôn ngữ, style bằng token `--pp-*`.
  Guard `if(document.getElementById("sw-update-banner")) return;` tránh hiện 2 lần.
- **`activate`:** dọn cache cũ (giữ `CACHE` hiện tại) + `clients.claim()`. Không gửi
  bất kỳ message nào về client — client không lắng nghe message SW cho việc update.
- **Ngoại lệ:** app voice giữ pattern cũ (`skipWaiting()` trong install) vì chưa có
  banner — khi nào thêm banner cho voice thì áp dụng pattern này.

## 8c. Quy tắc HTML
- **ID phải duy nhất toàn trang.** Trùng ID khiến `getElementById` chỉ trả về
  phần tử đầu tiên, các phần tử còn lại không bao giờ được update.
  (Lỗi thực tế 2026-10-07: trùng `profileTitle` ở tab Progress và tab Profile.)

## 8d. Quy tắc Database (D1)
- Thêm bảng/cột mới phải **chạy SQL trên D1 trước** khi deploy code dùng nó.
- Cột quota mới (vd: `ai_calls`) phải thêm vào `getUsage()` và `checkFeature()`
  trong `billing.js` cùng lúc — thiếu là quota không hoạt động.
- Đặt tên bảng/cột theo snake_case, khóa chính rõ ràng.

## 9. Bảo mật & đạo đức
- Không né CAPTCHA, anti-bot, fingerprint, rate limit. Không dùng proxy để vượt chặn.
- Không chép tay token, địa chỉ, chuỗi dài từ ảnh chụp màn hình.
- Trước khi tích hợp dịch vụ mới: **đọc Terms** rồi báo anh trước.
- Không lưu mật khẩu, token, key vào memory, file thường hay log.
- Tôn trọng quyền của anh với thiết bị, tài khoản, gia đình anh — anh quyết, em làm.

## 10. Tích hợp AI
- Mọi API AI phải có **cache** — câu hỏi giống nhau không gọi lại provider
  (bảng `ai_cache`, key = hash của input).
- **Quota theo gói**, đếm vào `usage_daily`, trả 402 khi hết.
- UI chỉ ghi "AI", **không ghi tên model/provider/công nghệ** (theo mục 5).
- Model mặc định: `gemini-3.8-flash`. Đổi model phải bàn với anh.
- Key để trong **Worker secret**, không hardcode, không log, không chép ra file.

## 11. Full-stack checklist (tính năng mới)
Mỗi tính năng mới phải đủ 3 lớp mới được coi là xong:
1. **UI**: đủ 4 ngôn ngữ, đúng token màu, không popup/modal.
2. **API route**: kiểm tra login (401), kiểm tra quota (402), validate input.
3. **D1 table**: tạo bảng/cột trước khi deploy (theo mục 8d).
- Thiếu một lớp là tính năng **chưa xong**, không được báo hoàn thành.

## 12. Deploy
- Mọi file HTML deploy phải có `?v=<timestamp>` mới cho JS/CSS để phá cache
  trình duyệt (cf_deploy.py tự làm).
- CSS chỉ serve từ asset, **không inline copy** trong worker (bài học 2026-10-06:
  sửa CSS không lên live vì worker serve bản inline cũ).

---

*Cập nhật: 2026-10-07 — **ĐÃ CHỐT**. Thêm tiếng Hàn vào mục 6; thêm quy ước đọc `elab_authToken` vào mục 8 (lỗi trang upgrade parse JSON nhầm). Thêm mục 8b quy trình sửa code (sau vụ tự gây lỗi: replace regex hàng loạt, nhúng JS vào onclick, tối ưu khi app chưa ổn định). Thêm mục 8c (ID duy nhất), 8d (quy tắc D1), 10 (tích hợp AI), 11 (full-stack checklist), 12 (deploy) — từ đợt build AI + vocab review.*
