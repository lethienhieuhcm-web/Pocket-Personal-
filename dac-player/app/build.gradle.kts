// app/build.gradle.kts — plan "dac"
// Java 21 bắt buộc (đồng bộ với decent-player/libs — mọi module dùng jvmToolchain(21))
import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    // AGP 9.x đã tích hợp sẵn Kotlin support — không cần org.jetbrains.kotlin.android nữa
    // 1.4: kotlinx.serialization (@Serializable) cho API JSON.
    alias(libs.plugins.kotlin.serialization)
    // 2.3: KSP (Room + Hilt) + Hilt plugin.
    alias(libs.plugins.ksp)
    alias(libs.plugins.hilt.plugin)
}

android {
    namespace = "one.lethanhdong.dac"
    compileSdk = 36

    defaultConfig {
        applicationId = "one.lethanhdong.dac"
        // decent-player yêu cầu Android 10+ (API 29) — doc GETTING_STARTED.md
        minSdk = 29
        targetSdk = 36
        // 4.10: bản Phase 4 (4.1→4.9) — deploy lên /dac.
        versionCode = 6
        versionName = "0.5.0"
        // 1.2: instrumented test chạy trên emulator CI.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        ndk {
            // Driver C++ của decent-player build cho ARM64 (máy Android thật).
            // ndkVersion phải khớp libs: 29.0.14206865
            abiFilters += listOf("arm64-v8a")
        }
    }
    ndkVersion = "29.0.14206865"

    buildTypes {
        debug {
            // 1.2: emulator CI là x86_64 — debug build thêm x86_64 để
            // connectedDebugAndroidTest chạy được (AGP lọc device theo ABI).
            // Release giữ arm64-v8a only (máy Android thật).
            ndk {
                abiFilters += listOf("arm64-v8a", "x86_64")
            }
        }
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // Ký release: CI đọc keystore từ env Dac_KEYSTORE_B64 (GitHub Secrets),
            // local đọc file dac-release.keystore (không commit).
            // Không có keystore → build unsigned (vẫn cài test được).
            signingConfig = signingConfigs.findByName("release")?.takeIf {
                System.getenv("Dac_KEYSTORE_B64") != null ||
                    rootProject.file("dac-release.keystore").exists()
            }
        }
        // 1.6: buildType "deploy" — APK cho trang /dac: arm64-v8a only (dưới giới
        // hạn 25 MiB của Cloudflare Workers assets), ký bằng debug key
        // (isDebuggable = true) để cài được như bản debug. x86_64 chỉ cần cho
        // emulator test nên chỉ có ở buildType debug; deploy không thêm x86_64
        // (thừa hưởng arm64-v8a từ defaultConfig).
        // matchingFallbacks: composite build decent-player/libs chỉ có
        // buildType debug/release (không có "deploy") — không có dòng này Gradle
        // báo "No matching variant ... BuildTypeAttr 'deploy'" (run #90).
        // signingConfig: buildType custom KHÔNG tự hưởng debug signing như
        // buildType debug — không có dòng này AGP ra APK unsigned (run #91
        // cho ra app-deploy-unsigned.apk), không cài được.
        create("deploy") {
            isDebuggable = true
            isMinifyEnabled = true
            matchingFallbacks += listOf("debug")
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    signingConfigs {
        create("release") {
            val b64 = System.getenv("Dac_KEYSTORE_B64")
            if (b64 != null) {
                // CI: decode keystore từ secret vào file tạm
                val ksFile = rootProject.file("build/dac-release.keystore")
                ksFile.parentFile.mkdirs()
                ksFile.writeBytes(Base64.getDecoder().decode(b64))
                storeFile = ksFile
            } else {
                storeFile = rootProject.file("dac-release.keystore")
            }
            storePassword = System.getenv("Dac_KEYSTORE_PASSWORD")
            keyAlias = System.getenv("Dac_KEY_ALIAS")
            keyPassword = System.getenv("Dac_KEY_PASSWORD")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    buildFeatures {
        viewBinding = true
        // 2.4: BuildConfig cho GOOGLE_WEB_CLIENT_ID
        buildConfig = true
    }

    // 2.4: Web OAuth client ID cho Google Sign-In — client Web app thật của
    // lethanhdong.one, lấy từ flow OAuth live (redirect accounts.google.com),
    // 2026-10-14. Dùng cho `aud` khi Worker verify ID token. Cùng giá trị với
    // secret GOOGLE_WEB_CLIENT_ID trên Worker.
    buildTypes {
        getByName("debug") {
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"130582344226-6ijelovsb41jkdgqo927000q33m43hpt.apps.googleusercontent.com\"")
        }
        getByName("release") {
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"130582344226-6ijelovsb41jkdgqo927000q33m43hpt.apps.googleusercontent.com\"")
        }
        getByName("deploy") {
            buildConfigField("String", "GOOGLE_WEB_CLIENT_ID", "\"130582344226-6ijelovsb41jkdgqo927000q33m43hpt.apps.googleusercontent.com\"")
        }
    }

    // 1.5: Licenses screen đọc THIRD_PARTY_NOTICES.md — copy file docs/ vào assets
    // lúc build (single source of truth, không drift 2 bản).
    sourceSets {
        getByName("main") {
            assets.srcDirs("src/main/assets", "build/generated/assets/licenses")
        }
    }
}

// AGP 9 built-in Kotlin: config compiler ở top-level, không dùng android.kotlin nữa
// (theo https://kotl.in/gradle/agp-built-in-kotlin và các repo đã migrate)
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

// 1.5: copy docs/THIRD_PARTY_NOTICES.md → assets lúc build để LicensesActivity đọc.
// rootProject = dac-player/ (Gradle root), file docs ở dac-player/docs/.
// Chạy trước preBuild để asset có mặt khi AGP đóng gói APK/AAB.
tasks.register<Copy>("copyLicenses") {
    from(rootProject.file("docs/THIRD_PARTY_NOTICES.md"))
    into(layout.buildDirectory.dir("generated/assets/licenses"))
    rename { "third_party_notices.md" }
}
tasks.named("preBuild") { dependsOn("copyLicenses") }

dependencies {
    implementation(libs.core.ktx)
    implementation(libs.appcompat)
    implementation(libs.material)
    implementation(libs.coroutines)
    implementation(libs.recyclerview)
    // 1.2: mã hoá token (EncryptedSharedPreferences).
    implementation(libs.security.crypto)
    // 1.4: Phase 1 Libraries — OkHttp (thay HttpURLConnection) +
    // kotlinx.serialization (thay JSONObject) + Coil (ảnh bìa).
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.coil)
    implementation(libs.lifecycle.runtime)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.session)
    // 1.5: FFmpeg LGPL tự build (Media3 1.9.3 + FFmpeg release/6.0 + NDK 27.1.12297006,
    // CI workflow build-ffmpeg-lgpl.yml). Thay Jellyfin GPL (đã xoá).
    // AAR nằm ở app/libs/media3-ffmpeg-lgpl.aar — KHÔNG qua Maven (Media3 không
    // publish decoder_ffmpeg dạng binary vì LGPL). Vẫn cần FFmpeg decoder vì
    // MediaCodec cắt 24-bit→16-bit (doc ma145).
    implementation(files("libs/media3-ffmpeg-lgpl.aar"))

    // 3 thư viện MIT của Ma145/decent-player, qua composite build
    // (substitution khai báo trong settings.gradle.kts).
    // Tọa độ theo kế hoạch Maven của họ (GETTING_STARTED.md).
    implementation("com.decent.usbaudio:decent-usb-audio-driver:0.1.0")
    implementation("com.decent.usbaudio:decent-usb-audio-wrapper-media3:0.1.0")
    // Optional: decode FLAC ra integer thô tại extractor (zero float).
    // Không có cũng được — FFmpeg xử lý FLAC qua float (vẫn bit-perfect).
    implementation("com.decent.usbaudio:decent-media3-decoder-flac:0.1.0")

    // Instrumented test (emulator CI) — 1.2 EncryptedPrefsTest.
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.core)
    // 4.10: Espresso UI tap-through (AuthActivity/MainActivity) trên emulator CI.
    androidTestImplementation(libs.espresso.core)
    // 2.3: Phase 2 Libraries — Room (cache library) + Hilt (DI) +
    // WorkManager (background copy) + jaudiotagger (đọc tag).
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.hilt.android)
    ksp(libs.hilt.compiler)
    implementation(libs.work.runtime.ktx)
    implementation(libs.jaudiotagger)
    // 2.4: Credential Manager cho Google Sign-In.
    // Khai báo trực tiếp (không qua version catalog) vì tên "credentials"
    // vừa là library vừa là namespace gây xung đột accessor trong Gradle.
    implementation("androidx.credentials:credentials:1.3.0")
    implementation("androidx.credentials:credentials-play-services-auth:1.3.0")
    // GetGoogleIdOption nằm trong googleid.
    // 1.2.1 compile bằng Kotlin quá mới (lỗi incompatible) → dùng 1.1.1.
    implementation("com.google.android.libraries.identity.googleid:googleid:1.1.1")
    // Room testing cho instrumented test DAO.
    androidTestImplementation(libs.room.testing)
    // 4.6: runTest cho test logic refresh token.
    androidTestImplementation(libs.coroutines.test)
}
