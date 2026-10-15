package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
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
    driveAuthManager: DriveAuthManager? = null,
) {
    data class Track(
        val id: String,
        val title: String,
        val size: Long,
        val mimeType: String,
        // 4.8: artist parse từ tên file ("Nghệ sĩ - Tên bài"); rỗng nếu không khớp quy ước
        val artist: String = "",
    )

    companion object {
        // Cache 24h — user bấm "Làm mới" để force refresh
        // 2.3: cache lưu trong Room (TrackEntity.cachedAt), không còn SharedPreferences.
        const val CACHE_TTL_MS = 24 * 60 * 60 * 1000L
    }

    private val auth by lazy { AuthManager(context, baseUrl) }
    private val driveAuth by lazy { driveAuthManager ?: DriveAuthManager(context) }

    /** 4.6: Mutex serialize refresh — tránh bão request khi nhiều call cùng 401. */
    private val refreshMutex = Mutex()

    /**
     * v3.0: Server tự quản Drive token (D1 + auto-refresh).
     * Client không cần lấy token từ AccountManager nữa.
     * Giữ wrapper để không phải sửa 6 callers, chỉ bỏ logic token.
     */
    internal suspend fun <T> withDriveToken(
        activity: android.app.Activity? = null,
        block: suspend (driveToken: String) -> T,
    ): T {
        // Server lấy token từ D1 theo session email. Client gửi chuỗi rỗng.
        return block("")
    }

    private fun authToken(): String? = auth.token()

    /** GET Worker API, trả về body string. Throw IllegalStateException nếu lỗi. */
    private suspend fun get(path: String, driveToken: String? = null): String =
        execute(path, driveToken, method = "GET")

    /** POST Worker API (body rỗng), trả về body string. */
    private suspend fun post(path: String, driveToken: String? = null): String =
        execute(path, driveToken, method = "POST")

    /** POST JSON lên Worker API. */
    private suspend fun postJson(path: String, json: String): String =
        execute(path, method = "POST", jsonBody = json)

    /** PUT JSON lên Worker API. */
    private suspend fun put(path: String, json: String): String =
        execute(path, method = "PUT", jsonBody = json)

    /** DELETE Worker API. */
    private suspend fun delete(path: String): String =
        execute(path, method = "DELETE")

    private suspend fun execute(
        path: String,
        driveToken: String? = null,
        method: String,
        jsonBody: String? = null,
    ): String =
        withContext(Dispatchers.IO) {
            val token = authToken() ?: throw IllegalStateException("Chưa đăng nhập")
            val builder = Request.Builder().url(baseUrl + path)
                .header("Authorization", "Bearer $token")
            // v3.0: không gửi X-Drive-Token nữa, server tự lấy từ D1.
            // Giữ điều kiện để backward-compat nếu sau này cần.
            if (driveToken != null && driveToken.isNotEmpty()) {
                builder.header("X-Drive-Token", driveToken)
            }
            if (jsonBody != null) {
                builder.method(method, jsonBody.toRequestBody("application/json".toMediaType()))
            } else if (method == "POST") {
                builder.post(ByteArray(0).toRequestBody(null))
            } else if (method == "DELETE") {
                builder.delete()
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

        // 4.6: tự refresh Drive token + retry 1 lần khi 401.
        val tracks = withDriveToken(activity) { driveToken ->
            val body = get("/api/dac/music", driveToken)
            parseTracks(ApiHttp.json.decodeFromString<MusicListResponse>(body))
        }

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
    suspend fun syncIndex(activity: android.app.Activity? = null): SyncResult =
        withDriveToken(activity) { driveToken ->
            val body = post("/api/dac/sync", driveToken)
            ApiHttp.json.decodeFromString(body)
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
        val encoded = java.net.URLEncoder.encode(parentId, "UTF-8")
        val resp = withDriveToken(activity) { driveToken ->
            val body = get("/api/dac/folders?parentId=$encoded", driveToken)
            ApiHttp.json.decodeFromString<FolderListResponse>(body)
        }
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
     * 4.8: Tìm kiếm metadata trong D1 index.
     * GET /api/dac/search?q=..&limit=..&offset=.. → {files, total, limit, offset}
     * Chưa sync → Worker fallback tìm live Drive (total=-1).
     */
    suspend fun search(
        query: String,
        limit: Int = 50,
        offset: Int = 0,
        activity: android.app.Activity? = null,
    ): SearchResult = withDriveToken(activity) { driveToken ->
        val encoded = java.net.URLEncoder.encode(query, "UTF-8")
        val body = get("/api/dac/search?q=$encoded&limit=$limit&offset=$offset", driveToken)
        val resp = ApiHttp.json.decodeFromString<SearchResponse>(body)
        SearchResult(
            tracks = resp.files.map { f ->
                Track(f.id, f.title.ifEmpty { f.name }, f.size, f.mimeType, f.artist)
            },
            total = resp.total,
        )
    }

    /** Kết quả tìm kiếm — không serialize (chỉ dùng nội bộ). */
    data class SearchResult(val tracks: List<Track>, val total: Int)

    @kotlinx.serialization.Serializable
    internal data class SearchResponse(
        val files: List<SearchFile> = emptyList(),
        val total: Int = 0,
    )

    @kotlinx.serialization.Serializable
    internal data class SearchFile(
        val id: String = "",
        val name: String = "",
        val artist: String = "",
        val title: String = "",
        val size: Long = 0,
        val mimeType: String = "",
    )

    /**
     * Lấy direct Drive URL để stream. ExoPlayer đọc trực tiếp từ Google.
     * 4.6: tự refresh Drive token + thử lại 1 lần khi Worker báo 401.
     * @param activity Activity để hiện dialog xin quyền Drive (nếu cần).
     */
    suspend fun streamUrl(
        id: String,
        activity: android.app.Activity? = null,
    ): String {
        return withDriveToken(activity) { driveToken ->
            val body = get("/api/dac/stream/$id", driveToken)
            ApiHttp.json.decodeFromString<StreamResponse>(body).url
        }
    }

    /** Kiểm tra đã kết nối Drive chưa. */
    fun isDriveConnected(): Boolean = driveAuth.selectedAccount() != null

    // ---------- 4.9: Playlist lưu trên D1 (đồng bộ giữa 2 máy) ----------

    /** 1 playlist (tóm tắt, không kèm items). */
    @Serializable
    data class PlaylistSummary(
        val id: String,
        val name: String,
        val itemCount: Int = 0,
    )

    /** 1 bài trong playlist. */
    @Serializable
    data class PlaylistItem(
        val fileId: String = "",
        val name: String = "",
        val artist: String = "",
        val title: String = "",
        val mimeType: String = "",
        val size: Long = 0,
    )

    @Serializable
    private data class PlaylistListResponse(val playlists: List<PlaylistSummary> = emptyList())

    @Serializable
    private data class PlaylistDetailResponse(
        val id: String = "",
        val name: String = "",
        val items: List<PlaylistItem> = emptyList(),
    )

    @Serializable
    private data class PlaylistIdResponse(val id: String = "", val name: String = "")

    @Serializable
    private data class PlaylistItemsRequest(val items: List<PlaylistItem>)

    @Serializable
    private data class PlaylistCreateRequest(val name: String)

    /** Lấy danh sách playlist của user. */
    suspend fun listPlaylists(): List<PlaylistSummary> {
        val body = get("/api/dac/playlists")
        return ApiHttp.json.decodeFromString<PlaylistListResponse>(body).playlists
    }

    /** Tạo playlist mới, trả về id. */
    suspend fun createPlaylist(name: String): String {
        val body = postJson(
            "/api/dac/playlists",
            ApiHttp.json.encodeToString(
                PlaylistCreateRequest.serializer(),
                PlaylistCreateRequest(name),
            ),
        )
        return ApiHttp.json.decodeFromString<PlaylistIdResponse>(body).id
    }

    /** Xoá playlist (kèm items). */
    suspend fun deletePlaylist(id: String) {
        delete("/api/dac/playlists/$id")
    }

    /** Lấy items của 1 playlist (đúng thứ tự). */
    suspend fun getPlaylistItems(id: String): List<PlaylistItem> {
        val body = get("/api/dac/playlists/$id")
        return ApiHttp.json.decodeFromString<PlaylistDetailResponse>(body).items
    }

    /** Thay toàn bộ items của playlist (dùng khi lưu/reorder). */
    suspend fun setPlaylistItems(id: String, items: List<PlaylistItem>) {
        put(
            "/api/dac/playlists/$id",
            ApiHttp.json.encodeToString(
                PlaylistItemsRequest.serializer(),
                PlaylistItemsRequest(items),
            ),
        )
    }
}
