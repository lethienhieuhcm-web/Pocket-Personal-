package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

/**
 * Client gọi Worker API — plan "dac-pass" (Chốt 2026-10-13) + dac-app 1.4.
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
 *
 * 1.4: HttpURLConnection → OkHttp (ApiHttp.client), JSONObject → kotlinx.serialization.
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
        // Cache 24h — user bấm "Làm mới" để force refresh
        // 2.3: cache lưu trong Room (TrackEntity.cachedAt), không còn SharedPreferences.
        const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L
    }

    private val auth by lazy { AuthManager(context, baseUrl) }
    private val driveAuth by lazy { DriveAuthManager(context) }

    private fun authToken(): String? = auth.token()

    /** GET Worker API, trả về body string. Throw IllegalStateException nếu lỗi. */
    private suspend fun get(path: String, driveToken: String? = null): String =
        withContext(Dispatchers.IO) {
            val token = authToken() ?: throw IllegalStateException("Chưa đăng nhập")
            val builder = Request.Builder().url(baseUrl + path)
                .header("Authorization", "Bearer $token")
            if (driveToken != null) {
                builder.header("X-Drive-Token", driveToken)
            }
            ApiHttp.client.newCall(builder.build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                when (resp.code) {
                    200 -> body
                    401 -> throw IllegalStateException("Hết phiên đăng nhập (401)")
                    400 -> throw IllegalStateException(
                        ApiHttp.readErrorMessage(body) ?: "Lỗi yêu cầu (400)"
                    )
                    else -> throw IllegalStateException(
                        ApiHttp.readErrorMessage(body) ?: "API lỗi: HTTP ${resp.code}"
                    )
                }
            }
        }

    private fun parseTracks(response: MusicListResponse): List<Track> =
        response.files.map { f ->
            Track(
                id = f.id,
                title = f.name.substringBeforeLast("."),
                size = f.size,
                mimeType = f.mimeType,
            )
        }

    /**
     * Lấy danh sách nhạc từ Drive qua Worker (dac-pass).
     * 2.3: Cache bằng Room (thay SharedPreferences JSON) — query offline,
     * survive restart, không giới hạn size.
     * @param forceRefresh true để bỏ qua cache.
     * @param activity Activity để hiện dialog xin quyền Drive (nếu cần).
     */
    suspend fun listMusic(
        forceRefresh: Boolean = false,
        activity: android.app.Activity? = null,
    ): List<Track> {
        val dao = MusicDatabase.getInstance(context).trackDao()
        // Đọc cache Room nếu còn hạn và không force refresh
        if (!forceRefresh) {
            val oldest = dao.oldestCachedAt()
            if (oldest != null && System.currentTimeMillis() - oldest < CACHE_TTL_MS) {
                val cached = dao.getAll()
                if (cached.isNotEmpty()) {
                    return cached.map { Track(it.id, it.title, it.size, it.mimeType) }
                }
            }
        }

        val driveToken = driveAuth.getToken(activity)
        val body = get("/api/dac/music", driveToken)
        val tracks = parseTracks(ApiHttp.json.decodeFromString<MusicListResponse>(body))

        // Lưu cache Room (xoá cũ, chèn mới với timestamp)
        val now = System.currentTimeMillis()
        dao.clear()
        dao.insertAll(tracks.map {
            TrackEntity(it.id, it.title, it.size, it.mimeType, now)
        })

        return tracks
    }

    /** Xoá cache danh sách nhạc (Room). */
    suspend fun clearCache() {
        MusicDatabase.getInstance(context).trackDao().clear()
    }

    /**
     * Tìm kiếm trong cache offline (2.3: Room query, không cần mạng).
     */
    suspend fun searchOffline(query: String): List<Track> {
        val dao = MusicDatabase.getInstance(context).trackDao()
        return dao.search(query).map { Track(it.id, it.title, it.size, it.mimeType) }
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
            val body = get("/api/dac/stream/$id", driveToken)
            return ApiHttp.json.decodeFromString<StreamResponse>(body).url
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
