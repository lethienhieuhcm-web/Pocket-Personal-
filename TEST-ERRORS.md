# Danh sách lỗi test thực — DAC Player "Đồng bộ thông minh"

> Ghi lại mọi lỗi phát hiện khi test thật (browser/API), không ghi lỗi đoán.
> Mỗi lỗi: mô tả, nguyên nhân gốc, cách sửa, trạng thái.

## Lỗi 1 — Web: toàn bộ JS chết do code cũ sót lại (2026-10-15)

**Phát hiện:** Anh báo trang DAC Player trống, bấm nút sync ⟳ không có gì xảy ra.

**Triệu chứng (test bằng browser thật):**
- Trang hiện header + 4 tab nhưng danh sách trống hoàn toàn (không có "Chưa có nhạc", không có lỗi).
- Bấm nút sync ⟳: không hiện "Đang cập nhật...", không hiện "✓ Đã cập nhật", không báo lỗi — im lặng hoàn toàn.
- Bấm tab Album: tab không chuyển (Bài hát vẫn sáng).

**Nguyên nhân gốc:**
1. Khi thay handler nút sync cũ bằng `smartSync`, em replace bằng Python string mà chỉ thay phần mở đầu, để sót lại ~20 dòng thân handler cũ ngay sau dòng `onclick`. Đoạn code sót dùng `await` ở top-level (ngoài async function) → **syntax error** → cả block `<script>` không parse được → toàn bộ JS của trang chết (không gắn handler, không load thư viện, không chuyển tab).
2. `smartSync` reset `libraryCache = null` rồi gọi `loadLibrary()`, mà `loadLibrary()` lại gọi `smartSync()` khi thấy data cũ hơn 15 phút → **loop vô hạn** (nếu script không chết vì lỗi 1).

**Cách sửa (đã làm):**
- Xoá sạch đoạn code cũ sót lại.
- Thêm flag `isSyncing` chặn gọi lồng nhau; `loadLibrary` chỉ gọi `smartSync` khi không đang sync.
- Khi sync fail thì hiện "Lỗi đồng bộ, thử lại sau" thay vì im lặng.
- Verify: `node --check` pass, deploy build 20261015164608, browser test lại: trang load thư viện, nút sync hiện "✓ Đã cập nhật", tab chuyển đúng.

**Trạng thái:** ✅ Đã sửa Web. Chưa sửa Android/iOS (chờ anh duyệt).

**Bài học 8b:** Cấm replace string mà không đọc lại toàn bộ đoạn sau khi sửa. Sau mỗi lần sửa HTML phải `node --check` phần JS trích ra + đọc bằng mắt.

---

## Lỗi 2 — Web: bấm phát nhạc báo "Không phát được file này." (2026-10-15)

**Phát hiện:** Anh gửi ảnh chụp màn hình — tab Thư mục hiện file `canon_in_d` (11.3 MB, MP3), bấm vào thì hiện lỗi đỏ "Không phát được file này."

**Triệu chứng:** Library load được (file hiện trong list), nhưng `playTrack` fail.

**Nguyên nhân gốc:** `worker/src/dac.js` có hàm `getDriveToken` riêng (duplicate) KHÔNG tự refresh token khi hết hạn — trả null luôn. Trong khi `worker/src/drive.js` đã có bản đúng tự refresh bằng `refresh_token`. Token Drive của anh hết hạn (~1h) → `/api/dac/stream` trả 400 'Drive not connected' → frontend báo "Không phát được file này."

**Cách sửa (kiểu ông lớn — DRY):**
- Thêm refresh logic vào `getDriveToken` của dac.js (dùng `refresh_token` đổi access token mới qua `oauth2.googleapis.com/token`, lưu lại D1).
- Export `getOAuthConfig` từ drive.js, import vào dac.js (xoá duplicate config).

**Trạng thái:** ✅ Đã sửa backend. Đang deploy + test.

---

## Lỗi 3 — Android/iOS: thiếu guard chống sync lồng nhau (2026-10-15)

**Phát hiện:** Review code sau lỗi 1 (theo luật "tự sửa lỗi không cần hỏi").

**Nguyên nhân gốc:**
- Android `MainActivity.onResume`: không có flag guard — `onResume` gọi nhanh liên tiếp có thể chạy nhiều sync song song.
- iOS `ContentView.smartSync`: set `isSyncing = true` nhưng không check ở đầu hàm; nếu `syncLibrary()` throw thì `isSyncing` kẹt `true` vĩnh viễn.

**Cách sửa:**
- Android: thêm `isSyncing` flag + `try/finally` reset.
- iOS: thêm `guard !isSyncing else { return }` + `defer { isSyncing = false }`.

**Trạng thái:** ✅ Đã sửa code. Chờ CI build.
