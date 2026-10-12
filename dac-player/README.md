# DAC Player — plan "dac"

App Android native phát nhạc bit-perfect qua USB DAC, dùng y chang 3 thư viện
MIT của `Ma145/decent-player`.

- Repo gốc: https://github.com/Ma145/decent-player
- Dùng: `libs/decent-usb-audio-driver`, `libs/decent-usb-audio-wrapper-media3`,
  `libs/decent-media3-decoder-flac` (MIT — được dùng thương mại, sửa, đóng gói)
- KHÔNG dùng: `driver/Felicity/` (AGPL-3.0, đụng vào phải open-source cả app)

Mọi version đã verify bằng clone thật repo gốc (2026-10-12), không đoán:
AGP 9.1.0, Gradle 9.3.1, Java 21, Media3 1.9.3, NDK 29.0.14206865.

Chưa verify bằng build thật (VM không có Android SDK) — lần build đầu tiên
trên máy anh / GitHub Actions nếu báo version không tồn tại thì pin lại:
- Kotlin 2.2.20 (suy ra từ AGP 9.1.0 cần Kotlin 2.x)
- build-tools 36.0.0, platforms android-36 (suy ra từ compileSdk 36)

## Kiến trúc (đã Chốt)

```
[FLAC trên R2] → [Worker API /api/dac/*] → [App native] → [USB DAC bit-perfect]
     (zero egress)      (list + auth)         (Kotlin+Media3)
```

- **Serve nhạc: Cloudflare R2** — zero egress fee, hỗ trợ Range seek,
  ExoPlayer đọc trực tiếp. Không cần VPS.
- **Build APK: GitHub Actions** — workflow `.github/workflows/build-dac-apk.yml`,
  free 2000 phút/tháng. Ký release bằng keystore từ GitHub Secrets.
- **GPU (Modal):** để sau, khi cần DSP/AI upsampling.

## Yêu cầu build local

- Android Studio (bản mới nhất) + Android SDK
- NDK `29.0.14206865` (khớp với libs — cài qua SDK Manager > SDK Tools > NDK)
- JDK 21 (Gradle toolchain tự tải nếu thiếu)
- DAC USB Audio Class 2.0 để test thật (VD: FiiO KA13, Cayin RU7...)

## Setup lần đầu

```bash
# 1. Clone repo gốc làm submodule — sparse-checkout CHỈ lấy libs/
#    (không lấy driver/Felicity/ vì AGPL-3.0)
git submodule add https://github.com/Ma145/decent-player.git decent-player
cd decent-player
git sparse-checkout set libs
cd ..

# 2. Mở thư mục này bằng Android Studio, chờ sync Gradle xong

# 3. Build
./gradlew assembleDebug

# 4. Cài lên máy, cắm DAC → cấp quyền USB → chọn file FLAC → phát
```

## Ký release (GitHub Actions)

Secrets cần tạo trong repo Settings > Secrets > Actions:

| Secret | Giá trị |
|---|---|
| `Dac_KEYSTORE_B64` | `base64 -w0 signing.keystore` (keystore hiện có) |
| `Dac_KEYSTORE_PASSWORD` | mật khẩu keystore |
| `Dac_KEY_ALIAS` | alias của key |
| `Dac_KEY_PASSWORD` | mật khẩu key |

Local: đặt file `dac-release.keystore` ở thư mục `dac-player/` (không commit).

## API contract phía Worker (D3)

App gọi (mirror theo `/api/drive/*` đang có):

```
GET /api/dac/music        → {files:[{id,name,size,mimeType}]}  (Bearer token)
GET /api/dac/stream/{id}  → {url}  (signed R2 URL, Bearer token)
```

Chưa implement — D3 sẽ làm phía Worker.

## Verify bit-perfect (theo doc của ma145)

```bash
# Driver phải là usbfs (của mình), không phải snd-usb-audio (của kernel)
adb shell "readlink /sys/bus/usb/devices/1-1:1.1/driver"

# AudioFlinger không được thấy USB (chỉ SPEAKER)
adb shell "dumpsys media.audio_flinger" | grep "Output devices:"

# Log pipeline: inflight ổn định, fb khớp sample rate file
adb logcat -d -s UsbAudioOutput | tail -20
```

Chi tiết: `decent-player/docs/driver/07-verification-and-diagnostics.md`

## Cấu trúc

```
dac-player/
├── .github/workflows/build-dac-apk.yml  # CI build + ký + upload APK
├── decent-player/            # git submodule (sparse: chỉ libs/)
├── settings.gradle.kts       # composite build + dependencySubstitution
├── app/src/main/
│   ├── AndroidManifest.xml            # USB host + USB_DEVICE_ATTACHED
│   ├── res/xml/usb_audio_device_filter.xml  # class="1" (USB Audio)
│   └── java/one/lethanhdong/dac/
│       ├── MainActivity.kt            # handle USB intent (theo doc ma145)
│       └── player/
│           ├── DacRenderersFactory.kt # buildAudioSink + UsbAudioSink (y chang doc)
│           ├── PlayerManager.kt       # ExoPlayer + attachToPlayer()
│           └── MusicApiClient.kt      # gọi /api/dac/* lấy list + stream URL từ R2
```

## License

- Code trong `app/` do mình viết.
- `decent-player/libs/*`: MIT — giữ nguyên file LICENSE của họ khi đóng gói.
