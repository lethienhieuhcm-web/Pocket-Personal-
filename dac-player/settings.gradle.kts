// settings.gradle.kts — plan "dac"
// Verify từ repo thật Ma145/decent-player (clone ngày 2026-10-12):
// - libs/ là 1 Gradle build duy nhất (settings.gradle.kts khai báo 3 modules)
// - libs KHÔNG khai báo `group` → phải substitution tường minh
// - libs dùng Kotlin DSL (.kts), AGP 9.1.0, Gradle 9.3.1, Java 21
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "dac-player"
include(":app")

// decent-player chưa lên Maven Central (theo README của họ) nên vendor qua
// git submodule (sparse-checkout chỉ lấy libs/, không lấy driver/Felicity/
// vì AGPL-3.0). Composite build vào thư mục libs/ duy nhất.
includeBuild("decent-player/libs") {
    dependencySubstitution {
        // Tọa độ đích theo kế hoạch Maven của họ (GETTING_STARTED.md).
        // Vì libs không khai báo `group`, map tường minh sang project path.
        substitute(module("com.decent.usbaudio:decent-usb-audio-driver"))
            .using(project(":decent-usb-audio-driver"))
        substitute(module("com.decent.usbaudio:decent-usb-audio-wrapper-media3"))
            .using(project(":decent-usb-audio-wrapper-media3"))
        substitute(module("com.decent.usbaudio:decent-media3-decoder-flac"))
            .using(project(":decent-media3-decoder-flac"))
    }
}
