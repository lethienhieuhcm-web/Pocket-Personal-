# app/proguard-rules.pro — plan dacweb v3.0 (S1: bật R8)
# Giữ các class dùng reflection để R8 không strip nhầm.

# Hilt
-keep class dagger.hilt.** { *; }
-keep class * extends dagger.hilt.internal.GeneratedComponent { *; }

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.AnnotationsKt
-keepclassmembers class kotlinx.serialization.json.** { *; }
-keep @kotlinx.serialization.Serializable class * { *; }

# Room
-keep class * extends androidx.room.RoomDatabase { *; }
-keep @androidx.room.Entity class * { *; }
-keep @androidx.room.Dao class * { *; }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**

# Media3/ExoPlayer
-dontwarn androidx.media3.**
-keep class androidx.media3.** { *; }
