package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

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
        execute(path, driveToken, method = "GET")

    /** POST Worker API (body rỗng), trả về body string. */
    private suspend fun post(path: String, driveToken: String? = null): String =
        execute(path, driveToken, method = "POST")

    private suspend fun execute(
        path: String,
        driveToken: String? = null,
        method: String,
    ): String =
        withContext(Dispatchers.IO) {
            val token = authToken() ?: throw IllegalStateException("Chưa đăng nhập")
            val builder = Request.Builder().url(baseUrl + path)
                .header("Authorization", "Bearer $token")
            if (driveToken != null) {
                builder.header("X-Drive-Token", driveToken)
            }
            if (method == "POST") {
                builder.post(ByteArray(0).toRequestBody(null))
            }
            ApiHttp.client.newCall(builder.build()).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                when (resp.code) {
                    200 -> body
                    401 -> {
                        val isDriveToken = runCatching {
                            ApiHttp.json.decodeFromString<ErrorResponse>(body).error
                        }.getOrDefault("").contains("Drive token invalid")
                        if (isDriveToken) {
                            throw DriveTokenInvalidException()
                        }
                        throw IllegalStateException("Hết phiên đăng nhập (401)")
                    }
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
     * 4.2: Đồng bộ index Drive vào D1 — POST /api/dac/sync.
     * Lần đầu full scan (lâu), các lần sau incremental (nhanh).
     * App gọi khi mở màn hình Thư mục / pull-to-refresh.
     */
    suspend fun syncIndex(activity: android.app.Activity? = null): SyncResult {
        val driveToken = driveAuth.getToken(activity)
        val body = post("/api/dac/sync", driveToken)
        return ApiHttp.json.decodeFromString(body)
    }

    @Serializable
    data class SyncResult(
        val full: Boolean = false,
        val synced: Int = 0,
        val total: Int = 0,
    )

    /**
     * 4.1: Duyệt thư mục Drive — GET /api/dac/folders?parentId=...
     * Trả về breadcrumb + thư mục con + file nhạc trong thư mục hiện tại.
     * Không cache (duyệt từng cấp, cần tươi).
     */
    data class FolderListing(
        val parentId: String,
        val parentName: String,
        val breadcrumb: List<BreadcrumbItem>,
        val folders: List<DriveFolder>,
        val tracks: List<Track>,
    )

    suspend fun listFolders(
        parentId: String = "root",
        activity: android.app.Activity? = null,
    ): FolderListing {
        val driveToken = driveAuth.getToken(activity)
        val encoded = java.net.URLEncoder.encode(parentId, "UTF-8")
        val body = get("/api/dac/folders?parentId=$encoded", driveToken)
        val resp = ApiHttp.json.decodeFromString<FolderListResponse>(body)
        return FolderListing(
            parentId = resp.parentId,
            parentName = resp.parentName,
            breadcrumb = resp.breadcrumb,
            folders = resp.folders,
            tracks = resp.tracks.map { f ->
                Track(
                    id = f.id,
                    title = f.name.substringBeforeLast("."),
                    size = f.size,
                    mimeType = f.mimeType,
                )
            },
        )
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
        } catch (e: DriveTokenInvalidException) {
            driveAuth.invalidateToken(driveToken)
            throw e
        } catch (e: IllegalStateException) {
            throw e
        }
    }

    /** Kiểm tra đã kết nối Drive chưa. */
    fun isDriveConnected(): Boolean = driveAuth.selectedAccount() != null
}
