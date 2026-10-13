package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Client gọi Worker API — plan "dac-pass" (Chốt 2026-10-13).
 *
 * Kiến trúc dac-pass:
 *   [Drive của user] → [Worker: verify + passthrough] → [App] → [USB DAC]
 * - App lấy Drive token từ AccountManager (DriveAuthManager).
 * - Mỗi request gửi 2 header: Authorization (PP session) + X-Drive-Token.
 * - Worker KHÔNG lưu token Drive.
 * - Danh sách nhạc cache 24h ở máy (giảm Worker requests → 0đ).
 *
 * API contract:
 *   GET /api/dac/music          → {files:[{id,name,size,mimeType}]}
 *   GET /api/dac/stream/{id}    → {url, name, mimeType, size}
 */
class MusicApiClient(
    private val context: Context,
    private val baseUrl: String = "https://lethanhdong.one",
) {
    data class Track(
        val id: String,
        val title: String,
        val size: Long,
        val mimeType: String,
    )

    companion object {
        private const val CACHE_PREFS = "dac_music_cache"
        private const val KEY_CACHE_JSON = "music_list"
        private const val KEY_CACHE_TIME = "music_list_time"
        // Cache 24h — user bấm "Làm mới" để force refresh
        const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L
    }

    private val auth by lazy { AuthManager(context, baseUrl) }
    private val driveAuth by lazy { DriveAuthManager(context) }
    private val cachePrefs by lazy {
        context.getSharedPreferences(CACHE_PREFS, Context.MODE_PRIVATE)
    }

    private fun authToken(): String? = auth.token()

    private suspend fun get(path: String, driveToken: String? = null): JSONObject =
        withContext(Dispatchers.IO) {
            val token = authToken() ?: throw IllegalStateException("Chưa đăng nhập")
            val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
            try {
                conn.setRequestProperty("Authorization", "Bearer $token")
                if (driveToken != null) {
                    conn.setRequestProperty("X-Drive-Token", driveToken)
                }
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                val code = conn.responseCode
                if (code == 401) throw IllegalStateException("Hết phiên đăng nhập (401)")
                if (code == 400) {
                    val err = JSONObject(conn.errorStream?.bufferedReader()?.readText() ?: "{}")
                    throw IllegalStateException(err.optString("error", "Lỗi yêu cầu (400)"))
                }
                if (code != 200) throw IllegalStateException("API lỗi: HTTP $code")
                JSONObject(conn.inputStream.bufferedReader().readText())
            } finally {
                conn.disconnect()
            }
        }

    private fun parseTracks(json: JSONObject): List<Track> {
        val arr = json.optJSONArray("files") ?: return emptyList()
        return List(arr.length()) { i ->
            val o = arr.getJSONObject(i)
            Track(
                id = o.getString("id"),
                title = o.getString("name").substringBeforeLast("."),
                size = o.optLong("size", 0),
                mimeType = o.optString("mimeType", ""),
            )
        }
    }

    /**
     * Lấy danh sách nhạc từ Drive qua Worker (dac-pass).
     * @param forceRefresh true để bỏ qua cache.
     * @param activity Activity để hiện dialog xin quyền Drive (nếu cần).
     */
    suspend fun listMusic(
        forceRefresh: Boolean = false,
        activity: android.app.Activity? = null,
    ): List<Track> {
        // Đọc cache nếu còn hạn và không force refresh
        if (!forceRefresh) {
            val cachedTime = cachePrefs.getLong(KEY_CACHE_TIME, 0)
            val cachedJson = cachePrefs.getString(KEY_CACHE_JSON, null)
            if (cachedJson != null && System.currentTimeMillis() - cachedTime < CACHE_TTL_MS) {
                try {
                    return parseTracks(JSONObject(cachedJson))
                } catch (e: Exception) {
                    // Cache hỏng → fetch mới
                }
            }
        }

        val driveToken = driveAuth.getToken(activity)
        val json = get("/api/dac/music", driveToken)

        // Lưu cache
        cachePrefs.edit()
            .putString(KEY_CACHE_JSON, json.toString())
            .putLong(KEY_CACHE_TIME, System.currentTimeMillis())
            .apply()

        return parseTracks(json)
    }

    /** Xoá cache danh sách nhạc. */
    fun clearCache() {
        cachePrefs.edit().remove(KEY_CACHE_JSON).remove(KEY_CACHE_TIME).apply()
    }

    /**
     * Lấy direct Drive URL để stream. ExoPlayer đọc trực tiếp từ Google.
     * Tự động invalidate Drive token nếu Worker báo 401.
     * @param activity Activity để hiện dialog xin quyền Drive (nếu cần).
     */
    suspend fun streamUrl(
        id: String,
        activity: android.app.Activity? = null,
    ): String {
        val driveToken = driveAuth.getToken(activity)
        try {
            val json = get("/api/dac/stream/$id", driveToken)
            return json.getString("url")
        } catch (e: IllegalStateException) {
            if (e.message?.contains("Drive token invalid") == true) {
                driveAuth.invalidateToken(driveToken)
            }
            throw e
        }
    }

    /** Kiểm tra đã kết nối Drive chưa. */
    fun isDriveConnected(): Boolean = driveAuth.selectedAccount() != null
}
