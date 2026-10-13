// app/build.gradle.kts — plan "dac"
// Java 21 bắt buộc (đồng bộ với decent-player/libs — mọi module dùng jvmToolchain(21))
import java.util.Base64

plugins {
    alias(libs.plugins.android.application)
    // AGP 9.x đã tích hợp sẵn Kotlin support — không cần org.jetbrains.kotlin.android nữa
}

android {
    namespace = "one.lethanhdong.dac"
    compileSdk = 36

    defaultConfig {
        applicationId = "one.lethanhdong.dac"
        // decent-player yêu cầu Android 10+ (API 29) — doc GETTING_STARTED.md
        minSdk = 29
        targetSdk = 36
        versionCode = 2
        versionName = "0.2.0-dac-pass"
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
            isMinifyEnabled = false
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
    }
}

// AGP 9 built-in Kotlin: config compiler ở top-level, không dùng android.kotlin nữa
// (theo https://kotl.in/gradle/agp-built-in-kotlin và các repo đã migrate)
kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

dependencies {
    implementation(libs.core.ktx)
    implementation(libs.appcompat)
    implementation(libs.coroutines)
    implementation(libs.recyclerview)
    // 1.2: mã hoá token (EncryptedSharedPreferences).
    implementation(libs.security.crypto)
    implementation(libs.lifecycle.runtime)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    implementation(libs.media3.session)
    // FFmpeg decoder — bắt buộc theo doc ma145 (MediaCodec cắt 24-bit→16-bit)
    implementation(libs.media3.ffmpeg.decoder)

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
}
