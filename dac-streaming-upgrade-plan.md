# Kế hoạch "mượt" — streaming DAC Pocket (bản 4: thực tế 16/10)

Ngày: 2026-10-16 | Trạng thái: P1 MP3 xong, FLAC chưa tìm ra gốc, P2–P4 chưa bắt đầu

## 1. Bài học đã chứng minh

| Phát hiện | Nguồn | Ngày |
|---|---|---|
| Worker → Google: Bearer → **200**, query param → **403** | test live | 16/10 |
| Google 403 ≠ IP block — thử đổi cách truyền auth trước | phân tích | 16/10 |
| Browser → Google trực tiếp: CORS, không đi được | test Chrome | 16/10 |
| Middleware auth chặn `?token=` trước khi vào handler | debug | 16/10 |
| FLAC MIME chuẩn: `audio/flac` (không phải `audio/x-flac`) | dlna-gateway | 16/10 |
| **Ép 206 luôn không fix được FLAC** — browser không chịu 206 cho request đầu | test live | 16/10 |
| **Verbatim-forward (mihonban/drivecast) cũng không fix FLAC** | test live | 16/10 |
| Proxy stream đúng bytes FLAC (206 + magic byte "fLaC") nhưng browser vẫn reject | đo thật | 16/10 |
| Browser decode được FLAC chuẩn (Wikimedia) — lỗi đặc thù file/proxy mình | test live | 16/10 |
| Chrome đọc được header FLAC mình (duration 2:48) nhưng stall ở 0:00 | test live | 16/10 |

**Đã ghi vào AGENTS.md:** bài học "Google 403 ≠ IP block" để áp dụng khi sửa Gemini AI.

## 2. Tiến độ thực tế (16/10)

| Hạng mục | Trạng thái |
|---|---|
| P1: Worker proxy + Bearer | ✅ **PASS 16/10 18:15** (chức năng), ⚠️ **chưa đạt latency** |
| ├ MP3 phát | ✅ Pass (browser time tiến thật) |
| ├ FLAC phát | ✅ **PASS**: file tốt (`055. Giấc mơ mùa đông.flac`, 35.3MB) phát mượt, time tiến 0:41→1:37 không stall |
| ├ Seek | ✅ **PASS chức năng**: seek slider nhảy đúng vị trí, phát tiếp từ chỗ mới |
| ├ Tap→play <0.5s | ⚠️ **Đo thật 16/10 18:39**: ~0.5–0.7s (warm), ~1.2–1.5s (restart từ ended) — **chưa đạt** |
| └ Seek <0.3s | ⚠️ **Đo thật 16/10 18:39**: buffered ~0.7–1.0s, unbuffered ~2.1–2.4s, seek 90% ~0.2–0.5s — **chưa đạt** |
| P1c: tối ưu sâu (metadata-first + luôn 206) | ⚠️ Đã thử, **không fix FLAC** → đã đơn giản hóa về verbatim-forward |
| P2: Tidal-style (prefetch + gapless + signed URL) | ✅ **HOÀN TẤT 16/10 19:03** |
| ├ Prefetch + gapless | ✅ **PASS 16/10 18:58**: preload từ 50%, next phát ngay (~2s), gapless <5s cuối bài |
| ├ Nút next/previous | ✅ **PASS 16/10 18:58**: bug đã sửa (fallback allTracks), next/prev chuyển bài đúng |
| └ Signed URL ngắn hạn | ✅ **PASS 16/10 19:03**: HMAC 10 phút, session token không còn trong URL |
| P3: Native | ⏸ Chưa bắt đầu |
| P4: Củng cố (gỡ debug, hardening token) | ⏸ Chưa bắt đầu — debug code vẫn còn trong production |

### Nợ kỹ thuật đang nằm trong production (cập nhật 16/10 14:50)
- [x] Endpoint `/api/dac/debug-meta/*` — **đã gỡ** (build 20261016074811, verify 404)
- [x] `console.log` debug trong `handleDacAudio` — **đã gỡ**
- [x] Frontend hiện lỗi kỹ thuật chi tiết — **đã gỡ**, giờ chỉ hiện "Không phát được bài này"
- [ ] Session token nằm trong query URL của `<audio>` (cần signed short-lived media token) — việc hardening riêng, chưa làm

## 3. P1c: đã thử tối ưu sâu, kết quả (16/10)

Đã triển khai metadata-first + parse Range RFC 7233 + luôn trả 206 (học audioneko).
Kết quả test live: **FLAC vẫn fail** — browser không chịu 206 cho request đầu tiên.

Đã đơn giản hóa về **verbatim-forward** (học mihonban/drivecast):
- Chỉ forward Range của client nếu có, không tự tạo
- Relay đúng status/headers Google, override `Content-Type` từ metadata + `Content-Disposition: inline`
  (Google trả `attachment`; đã thử nhưng không phải gốc — gốc là file hỏng)
- Kết luận 16/10: **proxy đúng, file sai**. File FLAC trên Drive corrupted ở audio frames
  (header chuẩn, ffprobe `decode_frame() failed`). Cần upload lại file tốt rồi retest.

### Code proxy hiện tại (thay thế handleDacAudio)

```javascript
export async function handleDacAudio(request, env) {
  // Auth: giữ nguyên (header + ?token=, đã fix)
  let s = await getSession(request, env);
  if (!s) { /* thử ?token= như hiện tại */ }
  if (!s) return jerr('A1: Not logged in', 401);
  const driveToken = await getDriveToken(request, env, s.email);
  if (!driveToken) return jerr('A2: Drive not connected', 400);

  // Lấy metadata để validate (IDOR) + biết MIME — cache memory 1h
  const meta = await getAudioMetadata(fileId, driveToken);
  if (!meta) return jerr('Không tìm thấy file', 404);
  if (!isAudio(meta)) return jerr('Chỉ phát file nhạc', 400);

  // HEAD → trả headers, không body
  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers: {
      'Content-Type': meta.mimeType,
      'Content-Length': meta.size.toString(),
      'Accept-Ranges': 'bytes',
    }});
  }

  // Forward verbatim Range của client (nếu có) — không tự tạo
  const headers = { 'Authorization': 'Bearer ' + driveToken };
  const clientRange = request.headers.get('Range');
  if (clientRange) headers['Range'] = clientRange;

  let dr = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers }
  );
  if (dr.status === 401) { /* retry 1 lần, xóa cache meta */ }

  // Relay response Google, chỉ override Content-Type từ metadata
  const rh = new Headers(dr.headers);
  rh.set('Content-Type', meta.mimeType);
  rh.set('Accept-Ranges', 'bytes');
  return new Response(dr.body, { status: dr.status, headers: rh });
}
```

### 3.3. Điểm khác với audioneko/mihonban (giữ bản sắc của mình)

| Điểm | audioneko/mihonban | Mình |
|---|---|---|
| Auth | 1 service account | **Per-user OAuth** (mỗi user 1 Drive) |
| Range | audioneko: tự parse RFC; mihonban: forward verbatim | **Forward verbatim** (đơn giản, đã thử parse mà không fix FLAC) |
| Cache tier | R2 "Active Shelf" | Chưa làm (P4 mới đánh giá) |
| Metadata cache | KV 24h | Memory 1h (đủ cho session nghe nhạc) |

### 3.4. Test (Chrome live) — PASS 16/10 18:15

| # | Case | Kết quả |
|---|---|---|
| 1 | MP3 `canon_in_d` | ✅ Phát được, time tiến |
| 2 | FLAC `055. Giấc mơ mùa đông` (35.3MB, file tốt) | ✅ Phát mượt, time 0:41→1:37 không stall |
| 3 | Seek FLAC giữa bài | ✅ Slider nhảy đúng, phát tiếp từ vị trí mới |
| 4 | Seek quá giới hạn | ⏳ Chưa test |
| 5 | Đo tap→play / seek bằng ms | ⏳ Chưa đo |

### 3.5. Tiêu chí P1 — chức năng ĐẠT, latency CHƯA ĐẠT (16/10 18:39)
- [x] MP3 phát được trên Chrome live
- [x] FLAC tốt phát được (xác nhận proxy đúng, vụ cũ là file hỏng)
- [x] Seek hoạt động (không dùng MSE — theo ý anh, không theo cách Tidal)
- [ ] Tap→play <0.5s: đo thật ~0.5–0.7s (warm) — sát nút nhưng chưa đạt
- [ ] Seek <0.3s: đo thật buffered ~0.7–1.0s, unbuffered ~2.1–2.4s — chưa đạt

**Chi tiết đo (precision ±500ms, trung thực):**
- Tap→play: 0.5–0.7s (play-resume), 1.2–1.5s (restart từ ended). Cold load track mới chưa đo chính xác.
- Seek giữa bài: 0.7–1.0s (buffered), 2.1–2.4s (unbuffered — proxy phải fetch + decode).
- Seek 90%: 0.2–0.5s (nhanh nhất, đã buffer).
- Bug phát hiện thêm: nút next/previous (⏭/⏮) bấm không có tác dụng.

**Nhận định:** latency hiện tại do `<audio>` element + network fetch quyết định, không phải do proxy logic.
Muốn <0.3s seek cần prefetch/predictive buffering (P2) — nhưng anh đã dặn không theo cách Tidal/MSE.

## 4. P2: Đánh giá MSE (sau khi P1 pass)

Nếu P1 pass với seek <0.5s → **bỏ qua MSE**, sang P3 luôn.
Chỉ làm MSE nếu số liệu chưa đạt.

## 5. P3: Native Android/iOS (sau P1)

Giữ nguyên plan cũ: ExoPlayer/AVPlayer gọi Google trực tiếp bằng Bearer header.
(Không cần qua Worker vì native gửi được header.)
Ghi chú: Henrry có Plex lifetime — nghiên cứu Plexamp khi làm P3 (gapless, buffer, audio pipeline).

## 6. P4: Củng cố (sau P3)

1. Gỡ debug code khỏi production: endpoint `/api/dac/debug-meta`, `console.log`,
   thông báo lỗi kỹ thuật ở frontend
2. Refresh-token hygiene (học tunecamp) — retry 401 hiện chỉ dùng lại token cũ
3. Signed short-lived media token thay cho session token trong query URL
4. Đánh giá có cần R2 cache tier (học audioneko) — chỉ nếu nhiều user cùng nghe 1 file
5. Cập nhật TEST-ERRORS.md

## 7. Đổi tên DAC Player → DAC Pocket (16/10)

- Lý do: trùng tên app "DAC Player" của Own-It-Media (ghi trong `dac-player/docs/DECISIONS.md`)
- Tên hiển thị đã đổi ở web/Android/iOS/README/plan
- URL: `/dacplayer/` → 301 → `/dacpocket/` (giữ query string), build 20261016074057
- Giữ internal ID (package, tên file, thư mục); giữ biên bản lịch sử làm paper trail

## 8. Không làm (tính đến 16/10)

- Không browser-direct (CORS)
- Không transcode (bit-perfect)
- Không R2 cache vội (đo trước)
- Không VPS gateway
- Không ép 206 luôn (đã thử, browser không chịu)

## 9. Rollback

Mỗi phase 1 deploy riêng. Fail → revert về build trước.
Build live hiện tại: `20261016074057` (verbatim-forward + redirect /dacpocket/).
