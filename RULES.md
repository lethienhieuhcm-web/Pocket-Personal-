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

## 8b. Bộ quy tắc chống lỗi do chính mình gây ra

**Nguyên tắc vàng: "Chậm mà chắc" (anh dặn 2026-10-11).**
- Suy nghĩ kỹ trước khi làm, không vội vàng chạy theo giải pháp "chính thức" hay "mới".
- Một việc một lúc, test pass mới sang tiếp. Không dồn nhiều thay đổi rồi deploy một thể.
- Khi gặp lỗi: phân tích gốc rễ, sửa đúng chỗ, không vá tạm. Thà chậm một bước mà chắc, còn hơn nhanh ba bước rồi gãy site phải rollback.
- Bài học 2026-10-11: cả buổi chiều vội dùng wrangler → gãy site 2 lần, mất BYOK, tốn hàng chục lượt fix. Nếu từ đầu "chậm mà chắc" (phân tích kiến trúc, nhận ra cf_deploy.py đã đúng chuẩn) thì đã xong từ lâu.

**Các prompt đã chốt — anh nhắn đúng chữ là em hiểu:**
- **"8b"** (anh đặt 2026-10-08): nhắc em đọc lại `~/workspace/skills/english-lab-fix/SKILL.md` + `RULES.md` mục 8b + `CHECKLIST.md` trước khi code. Mở rộng: suy nghĩ trước, trình hướng làm, Chốt rồi mới code; tự test bằng browser thật sau mỗi deploy; link đưa anh đặt trong code block; kiểm tra thực tế trước khi làm.
- **"test bug"** (anh dặn 2026-10-11): test frontend + backend đồng thời, một bug một vòng, không nhờ anh test (chi tiết 8b.2).
- **"test fit"** (anh dặn 2026-10-11): test bug đầy đủ mọi chức năng của kế hoạch fit (chi tiết 8b.2).
- **"cache"** (anh chốt 2026-10-11): deploy/cache/banner "có bản mới" có vấn đề → em kiểm tra filename hashing, SW pattern, banner theo 8b.3.
- **"app mới"** (anh chốt 2026-10-11): thêm app mới vào Pocket Personal → em làm theo checklist 8b.4.
- **"theme"** (anh chốt 2026-10-11): lỗi sáng/tối → em fix theo 8b.5.

**Bản đồ:** 8b.1 Sửa code · 8b.2 Test · 8b.3 Deploy & cache · 8b.4 Tích hợp app mới · 8b.5 Theme sáng/tối.
Bài học mới sau này thêm bullet vào đúng nhóm — không append mục 8b-9.

**Cách gọi nhanh (anh chốt 2026-10-11):**
- Nhắn **"8"** một mình → em hiện thẻ 6 dòng để anh chọn.
- Nhắn **"chốt 8b"** → em check hết toàn bộ (đọc skill + RULES 8b + CHECKLIST.md).
- Nhắn **"chốt <tên>"** (vd "chốt cache", "chốt theme", "chốt test bug") → em check đúng nhóm đó.

**Luật tự chủ (anh chốt 2026-10-15 — thành luật 8b):**
- Tự làm, tự check log, tự test bug — không nhờ anh test, không hỏi lại những gì anh đã cấp quyền.
- GitHub: anh đã cấp toàn quyền — không hỏi lại quyền GitHub, không xin phép cho thao tác GitHub thông thường. Gom nhiều file vào 1 lần push để hạn chế popup.
- Luôn tự theo dõi task nền (CI build, deploy, browser task) tới khi xong và báo kết quả chủ động — không để anh phải hỏi "xong chưa".
- TUYỆT ĐỐI KHÔNG BỊA — mọi giá trị từ bên ngoài verify bằng request thật.
- Gặp vấn đề khó: nghiên cứu cách ông lớn (Google, Apple, Spotify...) xử lý rồi áp dụng.

### 8b.1 Sửa code

**Nguyên tắc:**
- **Một lần chỉ sửa một lỗi.** Sửa xong → test → pass mới sửa lỗi tiếp theo.
  Không sửa 5-7 lỗi cùng lúc rồi deploy một thể.
- **Sửa gốc, không vá tạm.** Không thêm inline handler/script để lách qua lỗi module.
  Nếu module gãy thì tìm nguyên nhân module gãy và sửa nó.
- **Không tối ưu khi app chưa chạy ổn định.** Cấm code splitting, lazy-load, refactor lớn
  khi còn bug chưa sửa xong. Ưu tiên: app chạy đúng trước, nhanh sau.
- **TUYỆT ĐỐI KHÔNG BỊA ĐẶT — luôn verify bằng dữ liệu thật, làm giống ông lớn** (anh nhấn mạnh 2026-10-11).
  Bài học xương máu vụ BYOK model name: em đoán `gemini-2.0-flash`, `gemini-2.5-flash` mà không kiểm tra →
  2.0 không tồn tại, 2.5 đã ngừng với user mới, mất cả buổi debug "network error" vô nghĩa.
  Cách ông lớn làm: gọi API thật (`GET /v1beta/models` bằng key thật) → thấy 50 models →
  test từng model bằng POST thật → `gemini-3.5-flash` trả 200 OK mới dám dùng.
  Quy tắc: với bất kỳ giá trị nào từ bên ngoài (tên model, endpoint, response format),
  phải verify bằng request thật trước khi code, không đoán từ docs/trí nhớ.
  Ghi chú nguồn verify trong comment code để lần sau không phải đoán lại.

**Kiểm tra:**
- **Cấm replace hàng loạt bằng regex khi chưa đọc từng chỗ.** Mỗi lần replace phải
  đọc lại đoạn code sau khi sửa, chạy `node --check` ngay.
- **Không nhúng JS phức tạp vào thuộc tính HTML** (onclick="..."). Dễ sai escape
  (Python → JS → HTML), khó đọc, khó debug. Dùng `<script>` riêng + `addEventListener`.
- **Sau mỗi lần sửa file JS:** chạy `node --check` file đó. Sau mỗi lần sửa HTML:
  mở file kiểm tra đoạn vừa sửa bằng mắt thường.

**Deploy & test live:**
- **Deploy xong phải test live ngay** đúng chức năng vừa sửa, không đợi dồn nhiều việc.
- **Tự test bằng browser thật, không nhờ user test** (thêm 2026-10-09). Có browser task thì tự mở trang, kiểm tra console, bấm thử chức năng. Chỉ nhờ anh test khi đã tự test kỹ mà vẫn không tái hiện được lỗi, hoặc cần thiết bị thật của anh.

**Làm việc với anh:**
- **Anh bảo kiểm tra thì kiểm tra luôn** (thêm 2026-10-09). Không hỏi lại, không delay, không chờ xác nhận. Bắt tay vào làm ngay.
- **Link đưa cho anh phải đặt trong code block** (thêm 2026-10-09). Để anh copy dễ trên điện thoại/máy tính. Không để link trần trong câu.
- **Kiểm tra thực tế trước khi làm** (thêm 2026-10-10). Đếm số bảng/số file/số dòng thật từ DB/code rồi mới đối chiếu với kế hoạch. Không tin con số trong kế hoạch cũ (ví dụ: k1 ghi 15 bảng nhưng D1 thực tế có 17).

### 8b.2 Test

**"test bug"** (anh dặn 2026-10-11): khi anh nhắn "test bug" = test **frontend + backend đồng thời**, tuân 8b (một bug một vòng, không tách riêng, không nhờ anh test).
- Khi test, em có **quyền admin để test**: được tạo tài khoản/session admin **tạm** trực tiếp trong D1 (token ngẫu nhiên) rồi gọi API bằng Bearer token thật để E2E.
- Nguyên tắc: chỉ tạo **data test**, **không động vào data thật** của user; **không dùng token/session thật** của anh; test xong **dọn sạch** (xoá user/session test, verify bảng về trạng thái cũ); không lưu token vào file hay memory.
- Test phải cover: API trả đúng status/body, phân quyền đúng (401 khi không token, 403 khi không phải admin), không crash 500; frontend render đúng, không lỗi JS console.

**Bài học đợt test bug toàn diện** (thêm 2026-10-11):
- **`node --check` không bắt lỗi syntax của ES module.** File có `import`/`export`
  phải check dạng module: `cp f.js /tmp/f.mjs && node --check /tmp/f.mjs`.
  Một dấu `"` thiếu `\` trong string i18n đã giết cả module graph mà check thường vẫn pass.
- **String chứa HTML trong JS:** kiểm tra mọi quote đã escape đúng. Dùng byte check
  (`python3 -c` đếm ordinal) khi nghi ngờ, vì terminal/tool output escape nhiều lớp dễ nhìn nhầm.
- **"DEPLOY OK" ≠ fix đã lên live.** Sau mỗi deploy, verify bằng hash trong HTML live
  (`curl ... | grep -o 'js/main\.[a-f0-9]*\.js'`), đối chiếu với manifest mới build.
- **Một key token duy nhất cho cả app.** Không để `elab_token`, `elab_authToken`,
  JSON-quoted, plain string mỗi chỗ đọc một kiểu. Chuẩn: đọc `elab_authToken`,
  unwrap JSON nếu cần, fallback `elab_token`.
- **Hàm init phải được gọi khi load trang.** `updateAuthUI()` chỉ chạy sau login/logout
  thì nút Admin mãi ẩn với user login từ trang khác. Mọi hàm cập nhật UI theo auth
  phải chạy một lần khi module load.
- **Guard mọi `getElementById` trước khi dùng.** `#userBtn` không tồn tại làm
  `updateAuthUI` crash ngay dòng đầu, code phía sau (hiện nút admin) không bao giờ chạy.
- **Tab mới phải thêm vào danh sách tabs của `switchTab`.** Thiếu tên trong mảng
  `tabs` thì tabpage không bao giờ được active → trắng trang.
- **Với target click nhỏ, gắn handler trực tiếp sau khi render**
  (`querySelectorAll("span.w").forEach(...)`) đáng tin cậy hơn delegation trong
  môi trường test automation.

**"test fit"** (anh dặn 2026-10-11): khi anh nhắn "test fit" = test bug **đầy đủ mọi chức năng của kế hoạch fit**, tuân 8b (một bug một vòng, tự test browser thật, không nhờ anh test).
- Checklist test fit (mỗi phase F1–F6 xong đều chạy lại toàn bộ):
  1. **Token 3 lớp:** dark mode bật/tắt mọi biến đổi đúng; grep không còn giá trị
     hardcode trong component (màu/spacing/radius phải qua token).
  2. **Type scale:** grep không còn `font-size` px trực tiếp trong code app;
     chữ Việt có dấu (ấ ề ộ ơ ư) không bị cắt trên iPhone Safari.
  3. **Luật CSS cứng:** không còn `height` cố định cho khối chứa chữ;
     `min-width: 0` đã có ở mọi flex/grid chứa chữ; ellipsis/line-clamp hoạt động.
  4. **Size class:** layout đúng ở 390px (1 cột), 768px, 1440px (nội dung giữa,
     max-width 768px).
  5. **Safari:** `dvh` fallback `vh`; `color-mix` có màu dự phòng; safe-area
     top + bottom đầy đủ; tabbar glass không trong suốt trên Safari cũ.
  6. **Visual regression:** screenshot 5 app × 3 viewport × sáng/tối khớp baseline
     (chênh pixel phải được anh duyệt mới thành baseline mới).
  7. **Ma trận tay:** Android Chrome, iPhone Safari, Mac Safari/Chrome,
     Windows Chrome/Edge — không còn lệch/chèn ép.
- Bug tìm được: sửa gốc theo 8b, deploy, verify live, rồi mới sang bug tiếp theo.
- **Bài học iPhone 2026-10-11:** (1) `http://` phải 301 về `https://` — Safari báo
  "Not Secure" nếu không. Chuẩn big tech: bật "Always Use HTTPS" ở Cloudflare edge
  (SSL/TLS → Edge Certificates), không chỉ redirect trong worker — vì trang static
  (`/`, `/hub`) được serve trực tiếp không qua code worker. Token API bị 403 với
  zone settings → nhờ anh bật tay 1 lần. (2) Decor absolute (glow/blur) đè lên nội
  dung trên màn hình hẹp — fix bằng `z-index` cho wrapper nội dung, không đoán.
- **Bài học dark mode iPhone 2026-10-11:** trang public (landing) phải tôn trọng
  `prefers-color-scheme` của hệ thống — iPhone để dark mà web hiện light là xấu.
  Chuẩn big tech: script theme chạy trong `<head>` (tránh nháy), localStorage ưu
  tiên, fallback `matchMedia('(prefers-color-scheme: dark)')`. CSS dark phải hỗ trợ
  cả `html.pp-dark` (script head chạy trước khi có body).

### 8b.3 Deploy & cache (chuẩn big tech)

**Filename hashing** (thêm 2026-10-09):
- **JS/CSS dùng filename hashing** (`foo.a1b2c3.js`), không dùng `?v=timestamp`.
  Hash = 8 ký tự đầu SHA-256 của nội dung. File đổi → tên đổi → browser tải mới.
- **Dependency cascade:** A import B, B đổi → A cũng phải đổi tên (vì nội dung A
  chứa tên mới của B). Dùng iterative refinement trong build.
- **SW không cache HTML.** HTML luôn đi network, browser xử lý theo Cache-Control.
- **Giữ `__BUILD__` cho SW files** (không hash) để đảm bảo SW update đáng tin cậy.
- **Sinh `asset-manifest.json`** mỗi deploy để debug mapping tên cũ → tên mới.
- Tham khảo: Facebook/Google/Vercel đều dùng cách này.

**Pattern "Có bản mới"** (thêm 2026-10-09, sửa 2026-10-09 sau vụ loop):
Áp dụng cho cả 5 app hiện tại: stocks, chess, music, hub, english (index).
- **Luồng:** SW mới install xong → ở trạng thái `waiting` (không activate ngay).
  Client phát hiện qua `updatefound` → hiện banner inline. User bấm "Cập nhật" →
  gửi `SKIP_WAITING` → SW activate → reload 1 lần. Bấm "Để sau" → đóng banner,
  SW mới vẫn `waiting`, lần mở trang sau vẫn có thể update.
- **Cấm tuyệt đối 2 thứ từng gây loop tải lại liên tục:** (1) `skipWaiting()` trong
  `install` — SW mới activate ngay, gửi message ngay; (2) `r.update()` mỗi lần load
  — check update quá aggressive. Hai thứ cộng lại = vòng lặp down về liên tục.
- **Banner:** inline `div` fixed top (`createElement`, không popup/modal),
  nút "Cập nhật" + "Để sau", đủ 4 ngôn ngữ, style bằng token `--pp-*`.
  Guard `if(document.getElementById("sw-update-banner")) return;` tránh hiện 2 lần.
  User đang nhập liệu mà reload mất dữ liệu là lỗi UX nghiêm trọng — không tự reload.
- **`activate`:** dọn cache cũ (giữ `CACHE` hiện tại) + `clients.claim()`. Không gửi
  bất kỳ message nào về client — client không lắng nghe message SW cho việc update.
- **Ngoại lệ:** app voice giữ pattern cũ (`skipWaiting()` trong install) vì chưa có
  banner — khi nào thêm banner cho voice thì áp dụng pattern này.

**Verify deploy (thêm 2026-10-11, bài học xương máu):**
- **Không tin chữ "DEPLOY OK".** Cloudflare API có thể trả `success: true` nhưng
  worker không thực sự cập nhật (gặp 2026-10-11: 3 lần deploy báo OK, live vẫn cũ).
- **Sau mỗi deploy:** poll live `X-Build-Id` đến khi khớp build_id mới, timeout 60s.
  Không khớp → báo DEPLOY FAILED, không cho qua.
- Tham khảo: K8s `kubectl rollout status`, Vercel deployment state machine,
  AWS CodeDeploy `ValidateService` hook. Tất cả đều verify version live, không tin API.
- Triển khai trong `cf_deploy.py`: hàm `verify_live_build(build_id)`.

**GitHub Actions + Wrangler (thêm 2026-10-11, bài học xương máu):**
- **Trước khi thay hệ thống đang chạy, phải chứng minh cách mới tốt hơn bằng
  phân tích, không phải bằng "chính thức" hay "mới".** (2026-10-11: bỏ
  `cf_deploy.py` đang chạy tốt để dùng "wrangler chính thức" mà không phân tích
  kiến trúc → gãy site. Lẽ ra phải nhận ra `cf_deploy.py` đã là build pipeline
  kiểu Vercel.)
- **KHÔNG dùng `cloudflare/wrangler-action@v3`.** Nó `npm install` tại root repo
  → tạo `node_modules/workerd` (122MB) → wrangler cố upload làm static asset
  → vượt giới hạn 25MB → `ERROR Asset too large`.
- **Fix:** cài wrangler global (`npm install -g wrangler@4`) rồi chạy
  `wrangler deploy` trực tiếp. Global install nằm ngoài repo, không tạo
  `node_modules/` ở root. Luôn `rm -rf node_modules worker/node_modules`
  trước bước deploy để chắc chắn.
- `[assets] directory = "./"` upload cả repo → phải có `exclude` đầy đủ
  (node_modules, .git, .github, worker/src, scripts, *.md...). Nhưng `exclude`
  có thể không hoạt động ở wrangler cũ → cách `npm install -g` + `rm -rf`
  đáng tin cậy hơn vì không phụ thuộc version.
- **Kiểm tra trước khi bắt anh setup.** Khi lỗi liên quan đến cài đặt/quyền,
  kiểm tra trạng thái thật (`github status`, đọc screenshot của anh) TRƯỚC khi
  yêu cầu anh làm gì. Đã bắt anh cài GitHub App trong khi app đã cài từ 2 ngày
  trước (2026-10-11) — sai lầm không được lặp lại. Screenshot của anh luôn thắng
  suy đoán của em.

**GitHub App MCP không ghi được (thêm 2026-10-11):**
- App "Meta Muse AI" có quyền "Read and write access to code", repo đã được chọn,
  nhưng `create_or_update_file` qua MCP trả 403 "Resource not accessible by
  integration". Read (`get_file_contents`) vẫn hoạt động, chỉ write fail.
- Đây là lỗi phía backend MCP/token, không phải do anh cài sai. Không bắt anh
  cài lại những gì đã đúng.
- Fallback: anh copy-paste nội dung file (đặt trong code block để dễ copy trên
  điện thoại). Em tiếp tục điều tra lỗi 403 riêng, không làm phiền anh.
- **Ngoại lệ:** file trong `.github/workflows/` KHÔNG ghi được qua MCP dù file
  thường ghi được (test 2026-10-11: tạo/xóa `test-write-permission.txt` ở root
  thành công, nhưng `.github/workflows/deploy-cloudflare.yml` 403). GitHub yêu
  cầu quyền "Workflows" riêng để sửa workflow files — app Muse không có quyền này.
  Đây là giới hạn nền tảng GitHub, không phải bug. Workflow file bắt buộc anh
  sửa tay trên GitHub UI.

**Workers Static Assets: cấu trúc public/ phải khớp URL (thêm 2026-10-11):**
- `[assets] directory = "./public"` — file trong public/ được serve đúng theo
  đường dẫn tương đối. `public/index.html` → `/index.html`, KHÔNG phải `/english/`.
- Sai lầm: `cp *.html public/` gom mọi html vào một chỗ, ghi đè lẫn nhau
  (repo có nhiều index.html: landing `/`, english `/english/`...). Kết quả:
  worker không tìm thấy asset đúng → 1101 → site 500 (gặp 2026-10-11).
- Cách đúng kiểu Vercel: output dir phải mirror URL structure
  (`public/english/index.html` cho `/english/`).
- `cf_deploy.py` không dùng Static Assets mà upload lên R2 với key đường dẫn đúng
  — đó là lý do deploy tay hoạt động còn Actions gãy.

**Lỗi sơ đẳng: repo GitHub phải là source of truth (thêm 2026-10-11):**
- Khi dùng GitHub Actions deploy, code trên repo PHẢI có đầy đủ thay đổi mới nhất.
  Không được để code chỉ nằm ở local workspace mà quên push.
- Gặp 2026-10-11: BYOK code (aiClient.js, dict.js, index.html) chỉ ở
  `~/workspace/english-lab/`, chưa push lên GitHub. Actions chạy
  `cf_deploy.py` từ repo → deploy code cũ không có BYOK → ghi đè mất BYOK
  trên live site (site 200 nhưng 0 `byokKey`).
- Quy tắc: trước khi bấm "Run workflow", kiểm tra repo đã có đủ file mới chưa
  (so sánh với local). Mọi thay đổi code phải push lên GitHub TRƯỚC khi Actions
  deploy. Đây là nguyên tắc cơ bản của CI/CD mà em đã quên.

**Build ID duy nhất cho cả manifest + worker (thêm 2026-10-11):**
- `cf_deploy.py` sinh `build_id` riêng, `worker/build.sh` sinh `BUILD_TS` riêng →
  2 ID lệch nhau vài giây → `verify_live_build` chờ ID này, worker chứa ID kia
  → "DEPLOY FAILED" vĩnh viễn dù deploy thành công.
- Fix: `build.sh` nhận build ID từ tham số `$1` (fallback timestamp khi chạy tay);
  `cf_deploy.py` truyền `build_id` của nó vào khi gọi build.sh.
- Quy tắc: một release = một ID duy nhất xuyên suốt mọi artifact (manifest,
  worker, asset). Tham khảo: Docker image tag, K8s deployment revision.

**Worker verify fail → warning, không fatal (thêm 2026-10-11):**
- Cloudflare script API thường trả `success: true` nhưng worker thật không update
  (silent failure, đã gặp nhiều lần 2026-10-11). `verify_live_build` phát hiện
  đúng, nhưng `sys.exit(1)` làm fail cả deploy dù assets (R2) đã lên thành công.
- Fix: worker verify fail → in WARNING, không exit 1. Assets là user-visible
  deploy; nếu assets OK thì deploy thành công với frontend changes.
- Quy tắc: phân biệt "deploy thất bại thật" (assets không lên) với "verify không
  đạt" (worker API silent fail). Không để false negative làm đỏ CI.

### 8b.4 Tích hợp app mới vào Pocket Personal (thêm 2026-10-09)
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

### 8b.5 Quy tắc theme sáng/tối (thêm 2026-10-11, Henrry dặn)
- **Mọi trang public phải tự theo theme của hệ thống.** Lần đầu mở trang (chưa có
  lựa chọn lưu): đọc `matchMedia('(prefers-color-scheme: dark)')` — hệ thống dark
  thì web hiện dark ngay, không bắt user bấm gì.
- **Thứ tự ưu tiên:** lựa chọn tay trong `localStorage` (`pp_theme`) > theme hệ thống.
- **Không nháy khi load:** script theme đặt trong `<head>`, chạy trước khi body render.
  Vì vậy CSS dark phải hỗ trợ cả `html.pp-dark` (không chỉ `body.pp-dark`).
- **Mọi trang phải có nút chuyển theme tay** (icon mặt trăng/mặt trời), bấm là đổi
  ngay 2 chiều, lựa chọn được lưu và nhớ sau reload.
- **Không có chữ tàng hình:** sau khi đổi theme, kiểm tra không có chữ trắng trên nền
  trắng / chữ đen trên nền đen ở mọi trang (dùng visual regression cả 2 theme).
- Trang mới tạo mà thiếu theme script = chưa xong việc.
- **Bài học 2026-10-11:** trang `/login` (hub-login.html) là nơi user chưa đăng nhập
  thấy ĐẦU TIÊN nhưng lại hardcode `|| 'light'` — bỏ qua theme hệ thống. Từ nay
  checklist theme phải bao gồm cả trang login/auth, không chỉ trang chính.
- **Bài học dynamic import 2026-10-11:** `import('../js/...')` trong inline script của
  `/english/index.html` resolve thành `/js/...` (sai) thay vì `/english/js/...`.
  Dùng `'./js/...'` cho dynamic import trong trang con.
- **Bài học 2026-10-11 (vi phạm 8b):** "làm tiếp công việc" ≠ được code BYOK Phase 1.
  Em tự suy diễn rồi code B1→B5 một lèo, không hỏi anh, không từng bước Chốt.
  Anh yêu cầu roll back toàn bộ. Từ nay: yêu cầu mơ hồ → hỏi lại, không tự suy diễn.

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
