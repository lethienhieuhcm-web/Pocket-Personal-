# Kiến trúc DAC Pocket P3 Native Android "Trái Tim Nguyên Chất"

Ngày: 2026-10-16 · Người thực hiện: Muse (VM sandbox)
Trạng thái: ĐÃ CHỐT SPEC, CHƯA CODE
Phương pháp: tổng hợp từ mổ UAPP (7 patterns) + mổ Neutron (mixer gapless, USB tuning) — KHÔNG bịa, mọi quyết định đều có nguồn gốc rõ ràng.
**Xác thực kiến trúc từ 3 nguồn độc lập:** UAPP v7.1.2.8, Neutron v2.27.2, HiBy v4.3.1 — 3 hãng độc lập — đều đi cùng đường: **libusb + isochronous, bypass toàn bộ Android audio stack, Java chỉ xin quyền + giao FD cho native**. Sự hội tụ này là xác thực mạnh nhất cho quyết định chọn decent-player.

**Vai trò mỗi nguồn:**
- **UAPP** → nền móng: USB, chuỗi bit-perfect, setting per-DAC, quirks (được trích dẫn nhiều nhất vì mổ sâu nhất — có code thật)
- **Neutron** → tinh chỉnh: gapless kiến trúc mixer, Force 1ms packet, tách buffer network/driver
- **HiBy** → đúng phần cứng: userspace ALSA, async isochronous + feedback, khóa volume USB, bus speed override

---

## 1. Xác thực nguồn thiết kế

| Hạng mục | Giá trị |
|---|---|
| Spec gốc | `dac-app-plan-p3-spec.md` (Chốt 2026-10-16) |
| Thư viện USB | `Ma145/decent-player` (MIT, không AGPL) |
| Tham khảo 1 | Mổ UAPP v7.1.2.8 — `your_files/uapp-code-patterns.md` (7 patterns) |
| Tham khảo 2 | Mổ Neutron v2.27.2 — `your_files/neutron.md` (mixer gapless, 1ms packet) |
| Tham khảo 3 | Mổ HiBy v4.3.1 — `user/files/Ph_n_t_ch_ki_n_tr_c_HiBy_Music_9_s23d.md` (userspace ALSA, bus speed, volume lock) |
| Phân tích chi tiết | `user/files/Ph_n_t_ch_ki_n_tr_c_UAPP__1__7_zsw4.md` |
| Design system | `dac-design-tokens.md` (80/20, Chốt 2026-10-15) |
| Package | `one.lethanhdong.dac` (giữ nguyên theo đã Chốt) |
| Min/Target SDK | 26 / 36 |

---

## 2. Tổng quan 6 tầng kiến trúc (từ thấp lên cao)

```
┌─────────────────────────────────────────────────────────┐
│ 6. Ứng dụng Kotlin — UI, thư viện nhạc, setting per-DAC │
│    MVVM + Repository · Room · Signal Path visualization │
│    Dark only · Design tokens 80/20                      │
├─────────────────────────────────────────────────────────┤
│ 5. Cầu JNI — wrapper decent-player                      │
│    Không viết tay kiểu SWIG (học từ mục "Không học")    │
├─────────────────────────────────────────────────────────┤
│ 4. Engine native — decent-player                        │
│    FileQueue (gapless) · DoubleBuffer · OutputDevice    │
│    strategy · Chuỗi bit-perfect 3 bước                  │
├─────────────────────────────────────────────────────────┤
│ 3. Giải mã — FFmpeg (LGPL)                              │
│    FLAC/WAV/DSD · TagLib metadata                       │
│    SoX resample — CHỈ khi DAC không hỗ trợ rate gốc     │
├─────────────────────────────────────────────────────────┤
│ 2. USB driver — libusb + isochronous transfer           │
│    bypass toàn bộ audio stack Android                   │
│    (xác thực bởi UAPP + Neutron, 2 nguồn độc lập)        │
├─────────────────────────────────────────────────────────┤
│ 1. Hệ thống Android — USB Host API, UsbManager           │
│    (chỉ dùng để xin quyền + lấy file descriptor)        │
└─────────────────────────────────────────────────────────┘
        ↕ dự phòng khi không có DAC: Oboe → loa máy
          (badge đỏ "Không bit-perfect")
```

**Luồng dữ liệu:** File/Stream → StreamProvider → FileQueue (current/next decoder) → Decoder (FFmpeg) → DoubleBuffer (lót đĩa theo block) → [DSD→PCM nếu cần] → [SoX resample nếu bắt buộc] → OutputDevice → DAC.

---

## 3. Tầng USB — quyết định chi tiết

### 3.1. Intent filter (học từ UAPP Manifest)
```xml
<uses-feature android:name="android.hardware.usb.host" />
<meta-data android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
           android:resource="@xml/usbdevicefilter" />
```
`usbdevicefilter.xml` = `<usb-device class="1"/>` — chỉ bắt USB Audio Class.

### 3.2. Xin quyền (học từ UAPP `kh4.java`)
- Action tự định nghĩa: `one.lethanhdong.dac.USB_PERMISSION`
- Android 13+: `RECEIVER_NOT_EXPORTED`
- `getDeviceList()` → lọc class (1/0/239/255) → loại blocklist → `requestPermission()`
- Bỏ qua dock audio (vendor 2235) nếu ≥2 thiết bị

### 3.3. Giao cho native (học từ UAPP `lh4.d()`)
```kotlin
// Java chỉ làm "lễ tân": xin quyền + lấy FD + raw descriptor
val params = mapOf(
    "fd" to connection.fileDescriptor,
    "deviceName" to device.deviceName,
    "vendorId" to device.vendorId,
    "productId" to device.productId,
    "rawDescriptors" to connection.rawDescriptors,
)
nativeEngine.initializeUSBDevice(params)
```

### 3.4. Blocklist hạt giống (từ code UAPP `lh4.c()`)
14 vendor/product: 1478, 4184, 1133 (50475/50479), 5421, 12806, 1152, 2362, 3010, 6790/29987, 42500/1813, 6551/37479, 5964/21930, 1505, 2652.

---

## 4. Tầng engine — quyết định chi tiết

### 4.1. Đàm phán sample rate theo từng bài (học từ UAPP `AudioPlayer.java`)
```
1. isBitPerfectPossible(fileRate, dacRates)?
   - CÓ → setSampleRate(fileRate) → badge "Direct 16/44.1" ✅
   - KHÔNG → sameFamilyUpsample() → badge "Resample 44.1→88.2" ⚠️
2. Tuyệt đối KHÔNG nhảy chéo họ (44.1→96)
```

### 4.2. Chuỗi bit-perfect 3 bước (học từ mổ sâu UAPP)
```
isBitPerfectPossibleForUSB() → setBitPerfectWhenPossible() → copyIntToUSBBitPerfect()
```

### 4.3. Gapless (học từ UAPP + Neutron)
- **UAPP:** FileQueue giữ current + next decoder, `setNextDataSource` → `setNextToCurrent`
- **Neutron:** master-mixer chạy liên tục, sub-mixer cho từng bài (kiến trúc, không phải cờ)
- **DAC Pocket:** kết hợp — FileQueue pre-decode + mixer không dừng. KHÔNG crossfade.

### 4.4. DoubleBuffer (học từ mổ sâu UAPP)
Decode ghi theo block xuống buffer đĩa, render đọc theo block. Chịu được file DSD/lớn khi RAM ít.

### 4.5. OutputDevice strategy (học từ mổ sâu UAPP)
- USB → `copyIntToUSBBitPerfect` (đường chính)
- Loa máy → Oboe (dự phòng, badge đỏ)
- Android AudioTrack (dự phòng cấp 2)

### 4.6. USB tuning phơi ra user (học từ Neutron + HiBy)
- "Force 1ms packet" cho DAC firmware yếu (Neutron)
- "Ignore Audio Focus" — giữ DAC độc quyền khi đang phát (Neutron)
- "Bus speed override" Auto/Full/High cho DAC kén (HiBy)
- "Force sample rate" khi DAC báo sai capability (HiBy)
- Triết lý: audiophile muốn kiểm soát, không giấu

### 4.7. Hai đường USB song song (học từ HiBy — phát hiện quan trọng)
HiBy tách 2 loại thiết bị: UAC chuẩn (`USB_DEVICE_UAC=1`) + SA riêng cho đồ nhà HiBy (`USB_DEVICE_SA_RENDER=2`).
DAC Pocket v1 chỉ cần đường UAC chuẩn; kiến trúc phải cho phép thêm loại thiết bị mới mà không sửa lõi (pattern strategy).

### 4.8. Userspace ALSA (học từ HiBy — phát hiện quan trọng)
HiBy port logic driver USB audio của Linux kernel (`snd_usb_*`) lên chạy trên libusb:
parse descriptor, chọn clock source, set alt setting theo chuẩn UAC1/UAC2.
Cách làm "đúng phần cứng" hơn libusb thuần. v1 dùng decent-player;
ghi nhận pattern này cho phase quirks nâng cao khi gặp DAC kén.

### 4.9. Async isochronous + feedback endpoint (học từ HiBy)
Chế độ async: DAC làm chủ clock, host đồng bộ theo qua feedback endpoint.
Đây là chuẩn đúng cho bit-perfect. Verify decent-player có hỗ trợ async trước khi Chốt code.

### 4.10. Render switching tự động (học từ HiBy)
Cắm DAC có audio interface → tự chuyển sang USB render; rút ra → về loa máy. Không hỏi user.

### 4.11. DSD benchmark (học từ HiBy)
HiBy hỗ trợ DSD→PCM tới DSD512 + DST. DAC Pocket ưu tiên Native → DoP → PCM, chọn trong setting per-DAC.

---

## 6. Phần tự viết — lib không có, mình làm (Chốt 2026-10-17)

Nguyên tắc: spec P3 làm chuẩn. Lib thiếu gì thì tự viết ở app-level, tham khảo
cách UAPP / Neutron / HiBy đã làm. Không fork lib trừ khi bắt buộc
(buffer config là trường hợp duy nhất cần patch native).

| # | Hạng mục | Cách làm | Tham khảo |
|---|---|---|---|
| 7.1 | DSD DoP (v1) — **ĐÃ CODE 17/10** | `DopPacker.kt` + `DsfExtractor.kt` + `DopPackerTest.kt`. Pack DoP v1.1 (16 bit DSD + marker 0x05/0xFA luân phiên mỗi sample), DSF stereo little-endian, output PCM 176.4kHz/24-bit. Đăng ký qua `setExtractorsFactory` trong `PlayerManager`. 3 bug fix khi self-review: marker sai chuỗi (05,FA,FA,05), timeUs=0, endianness | Plan Phase 1 của chính tác giả lib (`DSD_SUPPORT.md`); HiBy `check dop dsd` |
| 7.2 | DSD Native (v2) | Cần alt setting riêng trong driver → làm sau khi v1 ổn (fork lib hoặc contribute upstream) | UAPP `getAvailableDSDRates`; HiBy UAC2 alt setting |
| 7.3 | DSD→PCM fallback | Dùng FFmpeg decode (có sẵn trong pipeline ExoPlayer của lib) | UAPP `libaudsd2pcm.so` |
| 7.4 | Buffer config 100/200/400ms | Patch native duy nhất: `USB_AUDIO_NUM_URBS` (đang hardcode 80) thành parameter qua JNI, default 80 | Neutron phơi low-latency config cho user |
| 7.5 | Hardware volume | App-level: UAC feature-unit `SET_CUR` qua USB control transfer; DAC không có feature-unit → software volume + báo rõ | UAPP `USBMixerUnit`; HiBy khóa volume USB |
| 7.6 | Quirks | Hardcode Kotlin object theo `vendorId:productId` (như UAPP `lh4.c()`); user override qua SharedPreferences (như Neutron/HiBy). KHÔNG dùng Room — quirks check ở USB hot path cần đồng bộ ngay; hạt giống từ blocklist UAPP | UAPP `lh4.c()` blocklist; Neutron `USBForce1MsPacket`; HiBy `UsbSpeedSettingActivity` |
| 7.7 | Đổi DAC khác giữa chừng | Lib singleton không hot-swap được → UX: cắm lại cùng DAC thì tự nối lại; cắm DAC khác → báo restart app | `KNOWN_LIMITATIONS.md` của lib |

**Thứ tự ưu tiên khi code:** driver integration → DoP (7.1) → hardware volume (7.5) → quirks (7.6) → buffer config (7.4) → DSD native (7.2, v2).

**Metadata v1:** MediaMetadataRetriever — lib không bundle TagLib.

---

## 5. Tầng ứng dụng — quyết định chi tiết

### 5.1. Per-DAC settings (học từ UAPP `bp.java`)
```kotlin
// Key: "<vendorId>:<productId>|||<flag>"
prefs["$dacId|||BitPerfect"] = true
prefs["$dacId|||IsGapless"] = true
prefs["$dacId|||DSDMethod"] = 0  // 0=Native, 1=DoP, 2=PCM
```
Cắm DAC → tự load setting của DAC đó.

### 5.2. Model Track — 2 trường sample rate (học từ UAPP)
```kotlin
data class Track(
    val originalSampleRate: Int,  // của file gốc
    val sampleRate: Int,          // thực ra DAC
    // ...
)
```

### 5.3. UI (tái dùng design system 80/20)
- **Dùng lại nguyên:** tokens dark, type scale, spacing, IA Library/Folder/Now Playing
- **Mới:** Signal Path visualization, badge "Direct 16/44.1", setting per-DAC, UI quirks
- **Điều chỉnh:** thêm variant màu cho trạng thái bit-perfect vs không

### 5.4. Điểm nhấn: Signal Path visualization
```
File 24/96 FLAC → Decode → USB → DAC (tên DAC, rate thực)
```

### 5.5. String đa nền tảng (rút kinh nghiệm từ Neutron)
- Không copy runtime string system của Neutron (overkill cho 3 codebase riêng)
- **Nhưng:** duy trì bảng string master chung để web/APK/iOS đồng nhất nội dung
- Mỗi nền tảng implement bằng chuẩn native (web: i18n lib, Android: res/values, iOS: Localizable.strings)

---

## 7. Những gì KHÔNG học (có lý do)

| Không học | Lý do |
|---|---|
| JNI SWIG viết tay | decent-player đã có wrapper Media3, viết lại = tốn tháng + thêm bug |
| PCM→DSD realtime | Niche trong niche, tốn CPU/pin, lợi ích tranh cãi. Để v2 |
| EQ | Phá bit-perfect, ngược triết lý "Trái Tim Nguyên Chất" |
| String runtime riêng (Neutron) | Overkill cho 3 codebase riêng; dùng master table + native i18n |
| AutoEq presets | Phụ thuộc EQ (đã không làm) |
| Giao thức SA riêng (HiBy) | Chỉ cho đồ nhà HiBy, không liên quan DAC chuẩn |
| RAAT endpoint (HiBy) | Ngoài scope v1 |
| LHDC/UAT Bluetooth (HiBy) | Ngoài scope v1 (tập trung USB bit-perfect) |
| ObjectBox thay SQLite (HiBy) | Đã Chốt Room, không đổi |

---

## 8. Đối chiếu quyết định với nguồn

| Quyết định DAC Pocket | Nguồn |
|---|---|
| libusb + isochronous, bypass Android | UAPP + Neutron + HiBy (3 nguồn độc lập) + decent-player |
| Java chỉ xin quyền, giao FD | UAPP `lh4.d()` |
| API capability query → set per-track | UAPP symbols mục 5 |
| Blocklist quirks | UAPP `lh4.c()` |
| Setting per-DAC `\|\|\|` | UAPP `bp.java` |
| Upsample cùng họ | UAPP `AudioPlayer.java` |
| Chuỗi bit-perfect 3 bước | UAPP (mổ sâu) |
| FileQueue gapless | UAPP (mổ sâu) |
| DoubleBuffer | UAPP (mổ sâu) |
| Mixer gapless kiến trúc | Neutron |
| Force 1ms packet + Audio Focus | Neutron |
| Tách buffer network/driver | Neutron |
| Bus speed override | HiBy `UsbSpeedSettingActivity` |
| Khóa volume USB | HiBy `UsbAudioLockSettingActivity` |
| Force sample rate | HiBy `forceSampleRate` |
| Seamless vs Fade loại trừ | HiBy `enableSeamless(!fade)` |
| Hai đường USB (UAC + SA) | HiBy `ActiveDeviceInfo.java` |
| Userspace ALSA (`snd_usb_*`) | HiBy strings `libhibyservice.so` |
| Async isochronous + feedback | HiBy `transfer->stream->stream_ep` |
| Render switching tự động | HiBy `sdk/MediaPlayer.java` |
| DSD→PCM tới DSD512 + DST | HiBy strings `libhibyservice.so` |
| DSD DoP app-level (v1) | Plan Phase 1 tác giả lib; HiBy `check dop dsd` |
| DSD Native (v2) | UAPP `getAvailableDSDRates`; HiBy UAC2 alt setting |
| DSD→PCM fallback (FFmpeg) | UAPP `libaudsd2pcm.so` |
| Buffer config (patch URBS) | Neutron low-latency config |
| Hardware volume (feature-unit) | UAPP `USBMixerUnit`; HiBy khóa volume |
| Quirks (hardcode + prefs) | UAPP `lh4.c()` blocklist; Neutron/HiBy user setting |
| Đổi DAC giữa chừng (UX) | Lib `KNOWN_LIMITATIONS.md` |
| Metadata (MediaMetadataRetriever) | Spec Chốt (lib không bundle TagLib) |
| Không SWIG tay, không EQ | Phân tích trade-off |

---

## 9. Giới hạn của tài liệu (đọc để khỏi hiểu lầm)

1. Kiến trúc dựa trên phân tích tĩnh UAPP/Neutron + spec đã Chốt — chưa code, chưa test runtime với DAC thật.
2. decent-player chưa được mổ chi tiết như UAPP/Neutron — cần verify API thực tế khi bắt tay code.
3. Số liệu performance (latency, buffer) là mục tiêu thiết kế, chưa đo thực tế.
4. Tài liệu phục vụ implement P3; mọi thay đổi cần Chốt lại trước khi code.
