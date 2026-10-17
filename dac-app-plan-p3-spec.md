# Spec P3 — DAC Pocket Native Android "Trái Tim Nguyên Chất"

**Ngày Chốt:** 2026-10-16 · **Trạng thái:** ĐÃ CHỐT SPEC, CHƯA CODE
**Triết lý:** Tín hiệu từ file tới DAC phải nguyên chất tuyệt đối. Bất kỳ khâu nào chạm vào bits đều phải báo cho user biết.

---

## 1. Quyết định đã Chốt

| # | Điểm | Quyết định |
|---|---|---|
| 1 | Scope v1 | **B** — Full (per-DAC settings, quirks, ReplayGain, DSD) |
| 2 | Nguồn nhạc | **A** trước (Drive qua Worker proxy) → B (local/NAS) sau khi ổn |
| 3 | UI | Học UAPP + điểm nhấn Signal Path visualization |
| 4 | Badge "Direct 16/44.1" | **Có** ngay v1 |

## 2. Kiến trúc (10 điểm)

| # | Điểm | Quyết định |
|---|---|---|
| 1 | USB permission | Auto-detect, hỏi 1 lần, nhớ thiết bị. Rút giữa chừng → pause + báo |
| 2 | Fallback loa máy | Có (Oboe), badge đỏ "Không bit-perfect" |
| 3 | DSD | Ưu tiên Native → DoP → PCM, chọn trong setting per-DAC. Benchmark: HiBy hỗ trợ DSD→PCM tới DSD512 + DST (tham khảo từ mổ HiBy 17/10) |
| 4 | EQ | **Không** v1 (phá bit-perfect) |
| 5 | Gapless | Bật mặc định, per-output |
| 6 | ReplayGain | Quét lúc sync, lưu DB |
| 7 | Buffer | User chỉnh 100/200/400ms, mặc định 200ms |
| 8 | Volume | Hardware DAC trước, software sau (báo rõ) |
| 9 | Background | Media3 session + notification (bắt buộc) |
| 10 | Điểm nhấn UI | **Signal Path visualization**: File → Decode → USB → DAC |

## 3. Chi tiết kỹ thuật (19 điểm)

| # | Điểm | Quyết định |
|---|---|---|
| 11 | DB local | Room |
| 12 | Sync D1 | Incremental khi mở, full khi >24h |
| 13 | Album art | Embedded → cache → placeholder. Không tải mạng v1 |
| 14 | Metadata | MediaMetadataRetriever (v1) — lib không bundle TagLib |
| 15 | Repeat | off / one / all |
| 16 | Shuffle | Fisher-Yates |
| 17 | Sleep timer | Có (15/30/60/90p + hết bài) |
| 18 | Crossfade | Không v1 |
| 19 | Cache | 2GB mặc định, LRU, chỉnh 500MB–8GB |
| 20 | Offline | Có (tải bài/album) |
| 21 | Mất mạng | Retry 3 lần backoff, rồi báo + thử lại |
| 22 | Theme | Dark only |
| 23 | Widget | Không v1 |
| 24 | Notification | Play/pause + next/prev + seek |
| 25 | Min SDK | 26 (Android 8.0) |
| 26 | Kiến trúc code | MVVM + Repository |
| 27 | Crash reporting | Firebase Crashlytics |
| 28 | Giá | Free v1 |
| 29 | Beta | APK qua web |

## 4. Trái tim — Signal path (35 bước, đã Chốt)

Java xin quyền → giao FD cho native → đàm phán rate/depth theo từng bài → decode FFmpeg → isochronous ra DAC. Chi tiết đầy đủ trong plan.

## 5. Học từ UAPP (đã ghi vào plan)

- **4.4:** Upsample cùng họ + tắt badge bit-perfect + model 2 trường sample rate
- **4.5:** Gapless per-output
- **4.11:** Setting theo từng DAC (`vendorId:productId`)
- **4.12:** Bảng quirks (hạt giống từ blocklist UAPP) + message lỗi riêng từng case
- **4.13:** Luồng USB (intent filter, permission, InitializeUSBDevice, skip dock audio)

## 5b. Học từ Neutron (bổ sung 16/10 — đã ghi vào plan)

- **4.5:** Gapless kiến trúc mixer (master chạy liên tục, sub-mixer cho từng bài) — thay vì chỉ là cờ
- **4.12:** Phơi "Force 1ms packet" ra cho user + tách bạch buffer (network preload ≠ driver latency)
- **4.14 (mới):** Ignore Audio Focus — giữ DAC độc quyền khi đang phát

## 6. UI/UX — Tái dùng design system 80/20 (Chốt 2026-10-16)

**Dùng lại nguyên (không đụng):**
- Tokens màu dark (`#0d1117`, accent `#0d9d6c`), type scale, spacing 4px base
- IA: Library trước, Folder sau, Now Playing
- Nguồn: `dac-design-tokens.md` (Chốt 2026-10-15)

**P3 bổ sung mới:**
- Signal Path visualization (điểm nhấn)
- Badge "Direct 16/44.1" realtime
- Màn hình setting per-DAC
- UI báo lỗi quirks (dễ hiểu + hướng sửa)

**Điều chỉnh nhỏ:**
- Thêm "ngôn ngữ" cho trạng thái bit-perfect vs không (màu badge, icon variant)
- Không redesign, chỉ thêm variant. Ước tính 80% UI dùng lại được.

## 6. Thư viện

- **decent-player** (MIT, đã Chốt) — libusb + isochronous + bypass Android
- **Oboe** — fallback loa máy
- **Không** tự build USB stack, **không** viết JNI tay kiểu SWIG
- Phần lib thiếu → tự viết ở app-level (mục 7), không fork lib trừ khi bắt buộc
  (buffer config là trường hợp duy nhất cần patch native)

## 7. Phần tự viết — lib không có, mình làm (Chốt 2026-10-17)

Nguyên tắc: spec P3 làm chuẩn. Lib thiếu gì thì tự viết ở app-level, tham khảo
cách UAPP / Neutron / HiBy đã làm (đã mổ và có báo cáo).

| # | Hạng mục | Cách làm | Tham khảo |
|---|---|---|---|
| 7.1 | DSD DoP (v1) | App-level, không đụng driver: custom DSF/DFF extractor → pack marker `0x05`/`0xFA` vào frame PCM 24-bit → set rate DoP tương đương (DSD64→176.4kHz…) | Plan Phase 1 của chính tác giả lib (`DSD_SUPPORT.md`); HiBy `check dop dsd` |
| 7.1a | **ĐÃ CODE 17/10** | `DopPacker.kt` (pack DoP v1.1, đảo bit, marker luân phiên) + `DsfExtractor.kt` (Media3 Extractor, DSF stereo, little-endian) + `DopPackerTest.kt` (unit test). Đăng ký vào `PlayerManager` qua `setExtractorsFactory`. 3 bug fix khi review: marker sai chuỗi, timeUs=0, endianness big/little | — |
| 7.2 | DSD Native (v2) | Cần alt setting riêng trong driver → làm sau khi v1 ổn (fork lib hoặc contribute upstream) | UAPP `getAvailableDSDRates`; HiBy UAC2 alt setting |
| 7.3 | DSD→PCM fallback | Dùng FFmpeg decode (có sẵn trong pipeline ExoPlayer của lib, Path 1) | UAPP `libaudsd2pcm.so` |
| 7.4 | Buffer config 100/200/400ms | Patch native duy nhất: `USB_AUDIO_NUM_URBS` (đang hardcode 80) thành parameter qua JNI, default 80 | Neutron phơi low-latency config cho user |
| 7.5 | Hardware volume | App-level: UAC feature-unit `SET_CUR` qua USB control transfer; DAC không có feature-unit → software volume + báo rõ | UAPP `USBMixerUnit`/`USBMixerUnitVolumeController`; HiBy khóa volume USB |
| 7.6 | Quirks table | Room table theo `vendorId:productId`; hạt giống từ blocklist UAPP (vendor 1478, 4184, 1133…) | UAPP `lh4.c()` blocklist |
| 7.7 | Đổi DAC khác giữa chừng | Lib singleton không hot-swap được → UX: cắm lại cùng DAC thì tự nối lại; cắm DAC khác → báo restart app | `KNOWN_LIMITATIONS.md` của lib |

**Thứ tự ưu tiên khi code:** driver integration (có sẵn) → DoP (7.1) → hardware
volume (7.5) → quirks (7.6) → buffer config (7.4) → DSD native (7.2, v2).

---

**Bước tiếp theo:** Code P3 khi anh ra lệnh. Hiện tại DỪNG ở spec.
