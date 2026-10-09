# Phụ lục B — Phân tích đặc biệt kỹ (2026-10-07, chưa code)

Vòng 3. Tập trung: runtime contract, bảo mật, toàn vẹn dữ liệu.

## F. CRITICAL — Mã hoá sentence bank bị hỏng toàn chuỗi

**Vị trí:** `js/features/auth.js:80-86` (client), `worker/src/library.js:15-22,5-13` (server)

```js
// auth.js — saveServerBank()
const payload = await encryptData(state.userKey, state.bank.slice(-500)); // mã hoá OK...
await apiCall("/api/bank", {method:"POST", body: JSON.stringify({bank: state.bank})});
// ...nhưng gửi state.bank PLAINTEXT. `payload` bị vứt bỏ.
```

Chuỗi hậu quả:
1. `handleBankPost` lưu nguyên body → R2 `bank/<email>.json` chứa **plaintext**.
2. `loadServerBank()` gọi `decryptData(key, j.bank)` với `j.bank` là array plaintext
   (không có `.iv`/`.data`) → `atob(undefined)` throw → `catch` → return `[]`.
3. `unlockBank()` cùng đường decrypt → cùng lỗi.

**Tác động kép:**
- **Privacy:** cam kết "sổ câu mã hoá AES-256 per-user, server không đọc được" bị phá vỡ —
  server đang lưu plaintext.
- **Chức năng:** sau mỗi lần save + reload (hoặc đổi thiết bị), bank load về `[]` —
  đồng bộ coi như hỏng. Trong 1 session vẫn thấy bank (state.bank trong memory) nên
  lỗi bị che giấu.

**Sửa đúng:** POST `{bank: payload}` thay vì `{bank: state.bank}` (1 dòng).
Dữ liệu plaintext cũ trong R2 cần migrate/xoá sau khi fix.

## G. Import graph sạch
- 92/92 import (static + dynamic) resolve được file thật — 0 broken import.
- 14 cảnh báo "missing named export" khi check là **false positive** của script
  (regex không match `export const $ = ...` do `$` + `\b`); `dom.js:2` export `$` bình thường.

## H. Bảo mật client
- **Không lộ secret** trong JS/HTML client (quét `api[_-]key|secret|bearer <token>` — sạch).
- **XSS:** vector rủi ro nhất (câu của user) được escape đúng — `sentence.js:25-29`
  dùng `esc()` trước innerHTML; `wordsHtml()` cùng pattern. Các innerHTML còn lại
  là icon/số/i18n — an toàn.
- `esc()` (`dom.js:7`) escape `&<>"` — đủ cho HTML context.

## I. Endpoint public — rà lại sau khi verify tay
| Endpoint | Thực tế | Kết luận |
|---|---|---|
| `/api/translate` POST | chỉ rate-limit IP, không auth | Proxy mở — quyết định ở E3 (giữ hay bắt login) |
| `/api/analytics` POST | không auth, có cap | Chấp nhận được, ghi nhận chủ đích |
| `/api/insights` GET | không auth, aggregate only | Chủ đích public (verify live 200, data đúng) |
| `/api/dict`, `/api/tts|voices|quota` | user auth | OK |

## J. Cache & PWA
- Không có `Cache-Control` explicit trên pages/APIs — dựa vào `?v=<timestamp>` stamping
  của deploy script (đã verify hoạt động). Chấp nhận được.
- Ngoại lệ: `VOICE_HTML` inline hardcode `?v=1791286992` **không bao giờ re-stamp**
  (deploy chỉ stamp file HTML, không stamp worker source) — sẽ hết khi tách voice.html (E1).

## K. Tổng hợp phát hiện 3 vòng (mức độ)
**Critical:** F (bank encryption hỏng toàn chuỗi)
**High:** E1 (voice.html chết), E2 (2 apiCall khác contract), E5 (xoá user mồ côi 9 tables D1)
**Medium:** E3 (translate public), E4 (5 internal routes chung 1 secret), J (v= hardcode trong worker)
**Đã tốt:** import graph, XSS escaping, secret hygiene, envelope lỗi `{error}` thống nhất
