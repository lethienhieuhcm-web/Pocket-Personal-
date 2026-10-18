package one.lethanhdong.dac.player

import android.content.Context
import java.io.File
import java.security.MessageDigest

/**
 * 4.3: Cache offline — lưu bài đã nghe để phát khi mất mạng.
 *
 * - Vị trí: cacheDir/audio/
 * - Key: SHA256 của URL (tránh ký tự đặc biệt)
 * - Chính sách: LRU, giới hạn dung lượng do user đặt
 * - 3 app đối chiếu (UAPP/Neutron/HiBy) đều không có vì họ chơi file local —
 *   đây là tính năng đặc thù của DAC Pocket (stream từ Drive).
 */
class AudioCacheManager(private val context: Context) {

    private val cacheDir: File by lazy {
        File(context.cacheDir, "audio").apply { mkdirs() }
    }

    /**
     * Lấy file cache cho URL. Trả về null nếu chưa cache.
     */
    fun getCachedFile(url: String): File? {
        val file = File(cacheDir, keyFor(url))
        return if (file.exists() && file.length() > 0) {
            // Cập nhật thời gian truy cập cho LRU
            file.setLastModified(System.currentTimeMillis())
            file
        } else null
    }

    /**
     * Lưu bytes vào cache. Tự dọn LRU nếu vượt giới hạn.
     */
    fun putToCache(url: String, data: ByteArray) {
        val file = File(cacheDir, keyFor(url))
        file.writeBytes(data)
        file.setLastModified(System.currentTimeMillis())
        evictIfNeeded()
    }

    /**
     * Dung lượng cache hiện tại (bytes).
     */
    fun cacheSize(): Long {
        return cacheDir.listFiles()?.sumOf { it.length() } ?: 0
    }

    /**
     * Giới hạn cache do user đặt (mặc định 1GB).
     */
    fun getMaxSize(context: Context): Long {
        val prefs = context.getSharedPreferences("dac_settings", Context.MODE_PRIVATE)
        return prefs.getLong("cache_max_mb", 1024) * 1024 * 1024
    }

    fun setMaxSize(context: Context, mb: Long) {
        context.getSharedPreferences("dac_settings", Context.MODE_PRIVATE)
            .edit()
            .putLong("cache_max_mb", mb.coerceIn(100, 10240))
            .apply()
    }

    /**
     * Xóa bài cũ nhất khi vượt giới hạn (LRU).
     */
    private fun evictIfNeeded() {
        val maxSize = getMaxSize(context)
        var size = cacheSize()
        if (size <= maxSize) return

        val files = cacheDir.listFiles()
            ?.sortedBy { it.lastModified() }
            ?: return

        for (file in files) {
            if (size <= maxSize * 0.9) break // Giữ lại 10% headroom
            size -= file.length()
            file.delete()
        }
    }

    /**
     * Xóa toàn bộ cache.
     */
    fun clear() {
        cacheDir.listFiles()?.forEach { it.delete() }
    }

    private fun keyFor(url: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val hash = digest.digest(url.toByteArray())
        return hash.joinToString("") { "%02x".format(it) }.take(32)
    }
}
