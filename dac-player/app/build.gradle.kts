// app/build.gradle.kts — plan "dac"
// Java 21 bắt buộc (đồng bộ với decent-player/libs — mọi module dùng jvmToolchain(21))
plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "one.lethanhdong.dac"
    compileSdk = 36

    defaultConfig {
        applicationId = "one.lethanhdong.dac"
        // decent-player yêu cầu Android 10+ (API 29) — doc GETTING_STARTED.md
        minSdk = 29
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0-d1"

        ndk {
            // Driver C++ của decent-player build cho ARM64 (máy Android thật).
            // ndkVersion phải khớp libs: 29.0.14206865
            abiFilters += listOf("arm64-v8a")
        }
    }
    ndkVersion = "29.0.14206865"

    buildTypes {
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
                ksFile.writeBytes(java.util.Base64.getDecoder().decode(b64))
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
    kotlin {
        jvmToolchain(21)
    }
    buildFeatures {
        viewBinding = true
    }
}

dependencies {
    implementation(libs.core.ktx)
    implementation(libs.appcompat)
    implementation(libs.coroutines)
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
}
