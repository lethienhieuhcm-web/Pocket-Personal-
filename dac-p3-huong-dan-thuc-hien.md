# Hướng dẫn thực hiện P3 — DAC Pocket Native Android "Trái Tim Nguyên Chất"

**Mục đích:** Tài liệu step-by-step để implement P3 từ spec đã Chốt.
**Đối tượng:** Developer Android (Kotlin + NDK).

---

## Phần 1: Chuẩn bị dự án

### 1.1. Tạo project
```
- Package: one.lethanhdong.dac (giữ nguyên theo đã Chốt)
- Min SDK: 26, Target SDK: 36
- Ngôn ngữ: Kotlin + Jetpack Compose (UI)
- Kiến trúc: MVVM + Repository
```

### 1.2. Dependencies (build.gradle.kts)
```kotlin
// Media3 (playback framework)
implementation("androidx.media3:media3-exoplayer:1.9.3")
implementation("androidx.media3:media3-session:1.9.3")
implementation("androidx.media3:media3-ui:1.9.3")

// decent-player (USB audio engine — MIT)
// Thêm module decent-player vào project, không dùng AAR ngoài

// Room (database local)
implementation("androidx.room:room-runtime:2.6.1")
implementation("androidx.room:room-ktx:2.6.1")
ksp("androidx.room:room-compiler:2.6.1")

// Oboe (fallback loa máy)
// Build từ source: https://github.com/google/oboe

// Firebase Crashlytics
implementation(platform("com.google.firebase:firebase-bom:33.x"))
implementation("com.google.firebase:firebase-crashlytics-ktx")
```

### 1.3. Manifest — USB intent filter
```xml
<uses-feature android:name="android.hardware.usb.host" />
<activity android:name=".MainActivity">
    <intent-filter>
        <action android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED" />
    </intent-filter>
    <meta-data android:name="android.hardware.usb.action.USB_DEVICE_ATTACHED"
               android:resource="@xml/usbdevicefilter" />
</activity>
```

`res/xml/usbdevicefilter.xml`:
```xml
<usb-device class="1" />  <!-- Chỉ bắt USB Audio Class -->
```

---

## Phần 2: Luồng USB (học từ UAPP)

### 2.1. Xin quyền
```kotlin
// Action tự định nghĩa
const val USB_PERMISSION = "one.lethanhdong.dac.USB_PERMISSION"

// Android 13+: dùng RECEIVER_NOT_EXPORTED
if (Build.VERSION.SDK_INT >= 33) {
    registerReceiver(usbReceiver, IntentFilter(USB_PERMISSION), RECEIVER_NOT_EXPORTED)
} else {
    registerReceiver(usbReceiver, IntentFilter(USB_PERMISSION))
}

// Liệt kê + lọc
usbManager.deviceList.values.forEach { device ->
    if (isAudioDevice(device) && !isBlocklisted(device)) {
        if (usbManager.hasPermission(device)) {
            openDevice(device)
        } else {
            val pi = PendingIntent.getBroadcast(context, 0, Intent(USB_PERMISSION), FLAG_MUTABLE)
            usbManager.requestPermission(device, pi)
        }
    }
}

// Bỏ qua dock audio (vendor 2235) nếu có ≥2 thiết bị
```

### 2.2. Lọc thiết bị (từ code UAPP `lh4.c()`)
```kotlin
fun isAudioDevice(device: UsbDevice): Boolean {
    val cls = device.deviceClass
    if (cls != 1 && cls != 0 && cls != 239 && cls != 255) return false
    // Blocklist (hạt giống từ UAPP)
    val blocked = mapOf(
        1478 to listOf(/* trừ 38411, 38405 */),
        4184 to listOf(), 1133 to listOf(50475, 50479),
        5421 to listOf(), 12806 to listOf(), 1152 to listOf(),
        2362 to listOf(), 3010 to listOf(),
        // ... đủ 14 vendor/product
    )
    // kiểm tra...
    return true
}
```

### 2.3. Giao cho native (từ code UAPP `lh4.d()`)
```kotlin
fun openDevice(device: UsbDevice) {
    val connection = usbManager.openDevice(device) ?: run {
        // Gửi message USBOpenFailed
        return
    }
    // Gói tin cho native:
    val params = mapOf(
        "fd" to connection.fileDescriptor,
        "deviceName" to device.deviceName,
        "vendorId" to device.vendorId,
        "productId" to device.productId,
        "rawDescriptors" to connection.rawDescriptors,
    )
    // Gửi vào hàng đợi native engine
    nativeEngine.initializeUSBDevice(params)
}
```

---

## Phần 3: Native audio engine (decent-player)

### 3.1. Tích hợp
- Thêm decent-player làm module native trong project
- JNI wrapper có sẵn (không viết tay kiểu SWIG)
- Java chỉ gọi API, không xử lý audio ở Java

### 3.2. API cần dùng (checklist từ symbols UAPP)
```
getAvailableSampleRates() → IntArray
isSampleRateAvailable(rate: Int) → Boolean
setSampleRate(rate: Int)
setSampleRateByIndex(index: Int)
getAvailableInputResolutions() → IntArray
setInputResolution(bits: Int)
setOutputResolution(bits: Int)
getAvailableDSDRates() → IntArray
setNativeDSD(enabled: Boolean)
setHardwareVolume(level: Float)
```

### 3.3. Luồng phát một bài
```
1. Lấy sampleRate + bitDepth từ file (metadata)
2. Query DAC: isSampleRateAvailable(fileRate)?
   - Có → setSampleRate(fileRate) → bitPerfect = true
   - Không → sameFamilyUpsample(fileRate) → bitPerfect = false
3. Query bit depth → setInputResolution / setOutputResolution
   - File 16-bit + DAC 24-bit → bit padding (vẫn bit-perfect)
4. Decode FFmpeg → PCM (native thread)
5. Isochronous transfer → DAC
6. Cập nhật UI: badge "Direct 16/44.1" hoặc "Resample 44.1→88.2"
```

### 3.4. Same-family upsampling (từ code UAPP)
```kotlin
fun sameFamilyUpsample(fileRate: Int, maxDacRate: Int, availableRates: IntArray): Int {
    return if (fileRate % 44100 == 0) {
        availableRates.filter { it % 44100 == 0 && it > 88200 && it <= 352800 && it <= maxDacRate }.maxOrNull() ?: 88200
    } else if (fileRate % 48000 == 0) {
        availableRates.filter { it % 48000 == 0 && it > 96000 && it <= 384000 && it <= maxDacRate }.maxOrNull() ?: 96000
    } else {
        fileRate // giữ nguyên nếu không thuộc họ nào
    }
}
```

---

## Phần 4: Per-DAC settings

### 4.1. Lưu trữ (học UAPP `|||`)
```kotlin
// Key: "<vendorId>:<productId>|||<flag>"
dataStore.edit { prefs ->
    prefs[booleanPreferencesKey("$dacId|||BitPerfect")] = true
    prefs[booleanPreferencesKey("$dacId|||IsGapless")] = true
    prefs[intPreferencesKey("$dacId|||DSDMethod")] = 0  // 0=Native, 1=DoP, 2=PCM
    prefs[booleanPreferencesKey("$dacId|||Upsampling")] = false
}
```

### 4.2. Tự động load
```kotlin
// Khi DAC được cắm → đọc setting của DAC đó → apply
fun onDacConnected(vendorId: Int, productId: Int) {
    val dacId = "$vendorId:$productId"
    val settings = loadDacSettings(dacId)
    applyToEngine(settings)
}
```

---

## Phần 5: UI

### 5.1. Màn hình chính
- Tab: Bài hát | Album | Nghệ sĩ | Thư mục (học DAC Pocket web)
- Dark theme only
- Badge format (FLAC/MP3/...) + sample rate

### 5.2. Now Playing — Signal Path visualization (điểm nhấn)
```
┌─────────────────────────────────┐
│  File: 24/96 FLAC               │  ← từ metadata
│    ↓ decode (FFmpeg)            │
│  USB: libusb isochronous        │  ← trạng thái engine
│    ↓                            │
│  DAC: [Tên DAC]                 │  ← từ USB descriptor
│  Output: Direct 24/96 ✅        │  ← bit-perfect badge
│  (hoặc: Resample 44.1→88.2 ⚠️)  │  ← khi không bit-perfect
└─────────────────────────────────┘
```

### 5.3. Notification
- Play/pause + next/prev + seek bar
- Hiện tên bài + badge format

---

## Phần 6: Background & Service

```kotlin
// Media3 session bắt buộc cho background playback
class PlaybackService : MediaSessionService() {
    // ...
}

// Xử lý rút DAC giữa chừng:
// → pause() + notification "DAC đã rút" + nút "Chuyển loa máy"
```

---

## Phần 7: Testing

### 7.1. Test với DAC thật (anh Henrry)
1. Cài APK qua web (như mọi lần)
2. Cắm DAC → kiểm tra auto-detect + xin quyền
3. Phát file FLAC → kiểm tra badge "Direct"
4. Thử file rate DAC không hỗ trợ → kiểm tra upsample cùng họ + báo rõ
5. Rút DAC giữa chừng → kiểm tra pause + thông báo
6. Test gapless với album live

### 7.2. Test không cần DAC
- Fallback Oboe → loa máy (badge đỏ "Không bit-perfect")
- Mọi chức năng UI vẫn test được

---

## Phụ lục: Tài liệu tham khảo
- Spec P3: `dac-app-plan-p3-spec.md`
- Plan tổng: `dac-app-plan.md` (Phase 4: bước 4.4, 4.5, 4.11, 4.12, 4.13)
- Phân tích UAPP: `your_files/uapp-code-patterns.md`
- Kiến trúc UAPP: `user/files/Ph_n_t_ch_ki_n_tr_c_UAPP_0_oe6g.md`
