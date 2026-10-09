# Build APK English Lab (Capacitor)

Project đã setup xong tại `~/workspace/english-lab/`:
- `capacitor.config.json` (appId: com.lethanhdong.englab)
- `android/` (native project)
- `www/` (web files để đóng gói)

## Cách 1: Build trên PC (khuyên dùng)

1. Cài Android Studio
2. Mở folder `~/workspace/english-lab/android` bằng Android Studio
3. Đợi Gradle sync xong
4. Menu Build → Build Bundle(s) / APK(s) → Build APK(s)
5. APK nằm ở `android/app/build/outputs/apk/debug/app-debug.apk`

## Cách 2: Command line (cần Android SDK)

```bash
cd ~/workspace/english-lab
npx cap sync android
cd android
./gradlew assembleDebug
# APK: app/build/outputs/apk/debug/app-debug.apk
```

## Ký APK để cài đè app cũ

Dùng keystore cũ `~/workspace/english-lab/apk/signing.keystore` (giữ fingerprint):

```bash
jarsigner -keystore ../apk/signing.keystore app-debug.apk <alias>
zipalign -v 4 app-debug.apk english-lab-v3.apk
```

## Lưu ý
- Mỗi lần sửa web code: copy files mới vào `www/` rồi chạy `npx cap sync android`
- Hoặc sửa trực tiếp ở `~/workspace/english-lab/` rồi copy sang `www/`
