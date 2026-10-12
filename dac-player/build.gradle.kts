// build.gradle.kts (root) — plan "dac"
// Version verify từ decent-player/libs (clone 2026-10-12):
// - AGP 9.1.0 (libs/build.gradle.kts)
// - Java 21 (tất cả modules dùng jvmToolchain(21))
plugins {
    id("com.android.application") version "9.1.0" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
}
