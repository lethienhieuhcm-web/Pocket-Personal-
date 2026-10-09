# English Lab — đưa lên mạng, dùng mọi nền tảng

App chạy mọi nơi có trình duyệt hiện đại: **Android, iPhone, iPad, Windows, Mac**.
Không cần cài từ App Store — cài kiểu PWA (đưa icon ra màn hình chính).

## Cách 1: Cloudflare Pages (khuyên dùng — miễn phí)

1. Vào **dash.cloudflare.com** → **Workers & Pages** → **Create** → tab **Pages** → **Upload assets**.
2. Đặt tên project `english-lab` → kéo **các file** này vào:
   - `index.html`, `manifest.json`, `sw.js`, `icon.svg`
   - `icon-180.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`
   - thư mục `.well-known/assetlinks.json` (xem mục APK bên dưới)
   → **Deploy**.
3. Có ngay link `https://english-lab.pages.dev` — mở là chạy.

## Cách 2: GitHub Pages (miễn phí, link vĩnh viễn)

1. **github.com** → **+** → **New repository** → tên `english-lab` → **Public** → **Create**.
2. **Add file** → **Upload files** → kéo các file ở Cách 1 vào → **Commit changes**.
3. **Settings** → **Pages** → **Source**: **Deploy from a branch** → Branch **main** → **Save**.
4. Đợi 1–2 phút → `https://<tên-github-của-anh>.github.io/english-lab/`

## Cài ra màn hình chính (từng nền tảng)

| Nền tảng | Cách cài |
|---|---|
| **Android** (Chrome) | Mở link → menu **⋮** → **Add to Home screen** (hoặc **Install app**) |
| **iPhone / iPad** (Safari) | Mở link → nút **Share** → **Add to Home Screen**. Từ iOS 16.4 trở lên mới nhận được 🔔 từ của ngày |
| **Windows** (Chrome/Edge) | Mở link → icon **Install** trên thanh địa chỉ (hoặc menu → **Install English Lab**) |

## Lên app Android thật (file APK — cài như app CH Play)

PWA ở trên đã "gần như app". Muốn file **.apk** cài đặt như app thường thì làm thêm:

**Bước 1 — Deploy lên link công khai** (3 phút, làm 1 lần): theo Cách 1/2 ở trên,
nhớ gồm cả `.well-known/assetlinks.json`.

**Bước 2 — Build APK** (5 phút, anh tự làm hoặc gửi link cho em — em build hộ):
1. Vào **pwabuilder.com** → dán link `https://english-lab.pages.dev` → **Start**.
2. Chờ chấm điểm PWA xong → **Package for stores** → chọn **Android** → **Download**
   → được file `.apk`. Chép vào điện thoại → mở file → **Install** → có icon
   English Lab trong máy, mở lên không thấy thanh địa chỉ trình duyệt.
3. (Cho chuẩn) PWABuilder sẽ hiện **SHA-256 fingerprint** — copy nó, dán vào
   `.well-known/assetlinks.json` thay chỗ `__DAN_SHA256_CUA_PWABUILDER_VAO_DAY__`,
   upload lại. Từ đó Android tin app hoàn toàn.

**Windows:** không cần APK — mở link bằng Edge/Chrome → icon **Install** trên thanh
địa chỉ → có app Windows thật (nằm trong Start menu, gỡ như app thường).
**iPhone/iPad:** Apple không cho cài APK — dùng **Add to Home Screen** ở bảng trên,
vẫn ra icon + mở toàn màn hình như app.

## Chuyển dữ liệu sang link mới / máy mới

Từ vựng và API key lưu theo từng địa chỉ web + từng máy, nên chuyển 1 lần:

1. Mở chỗ cũ → tab **Settings** → card **💾 Full backup** → **⬇ Export** (ra file JSON: từ vựng, câu, streak, cài đặt — không gồm API key).
2. Mở chỗ mới → **⬆ Import** → chọn file → xong.
3. Dán lại API key 1 lần (nếu dùng engine trả phí).

## Khác biệt giữa các nền tảng (đã xử lý sẵn)

- **Chấm phát âm / roleplay** (cần nhận diện giọng nói): chạy tốt trên **Chrome/Edge** (Android, Windows).
  Trên **iPhone/iPad** (Safari không hỗ trợ), app tự chuyển sang chế độ tự luyện — vẫn nghe mẫu, vẫn đọc theo, chỉ không chấm điểm tự động.
- **Giọng đọc Browser** (miễn phí, offline): chạy mọi nền tảng, kể cả iOS.
- **🔔 Từ của ngày**: Android/Windows nhận ngay sau khi cho phép. iPhone/iPad cần **cài ra Home Screen** + iOS 16.4+.
- **Offline**: mở app không cần mạng (học từ, flashcard, quiz). Nghe phát âm, từ điển, OCR cần mạng.

## Cập nhật bản mới sau này

Upload đè file `index.html` mới vào Pages/GitHub → tự cập nhật sau ~1 phút.
Từ vựng không mất (lưu trong máy anh). Đổi máy/đổi link thì dùng **💾 Full backup**.
