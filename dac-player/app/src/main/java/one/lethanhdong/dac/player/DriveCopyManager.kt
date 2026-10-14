package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Quản lý copy nhạc từ Drive share link — plan dac-app 2.1.
 *
 * Luồng (theo kiến trúc dac-pass):
 * 1. App parse link sơ bộ (DriveLinkParser) → gọi Worker POST /api/dac/resolve
 * 2. Worker trả về metadata + danh sách file audio (nếu là folder)
 * 3. User chọn file → app gọi Worker POST /api/dac/copy từng file
 * 4. Worker thử server-side copy (files.copy) — nhanh, không tốn băng thông
 *
 * Auth: session Pocket Personal (Authorization) + X-Drive-Token (như MusicApiClient).
 * Worker KHÔNG lưu token Drive.
 */
class DriveCopyManager(
    private val context: Context,
    private val baseUrl: String = "https://lethanhdong.one",
) {
    private val auth by lazy { AuthManager(context, baseUrl) }
    private val driveAuth by lazy { DriveAuthManager(context) }

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()

    /** POST Worker API với auth + drive token. Throw IllegalStateException nếu lỗi. */
    private suspend fun post(
        path: String,
        bodyJson: String,
        activity: android.app.Activity? = null,
    ): Pair<Int, String> = withContext(Dispatchers.IO) {
        val token = auth.token() ?: throw IllegalStateException("Chưa đăng nhập")
        val driveToken = driveAuth.getToken(activity)
        val req = Request.Builder()
            .url(baseUrl + path)
            .header("Authorization", "Bearer $token")
            .header("X-Drive-Token", driveToken)
            .post(bodyJson.toRequestBody(jsonMediaType))
            .build()
        ApiHttp.client.newCall(req).execute().use { resp ->
            Pair(resp.code, resp.body?.string().orEmpty())
        }
    }

    /**
     * Resolve share link → thông tin file/folder + danh sách file nhạc.
     * @throws IllegalStateException với message user-friendly khi lỗi.
     */
    suspend fun resolve(
        link: String,
        activity: android.app.Activity? = null,
    ): ResolveResponse = withContext(Dispatchers.IO) {
        if (!DriveLinkParser.looksValid(link)) {
            throw IllegalStateException("Link không đúng định dạng Google Drive")
        }
        val (code, body) = post(
            "/api/dac/resolve",
            ApiHttp.json.encodeToString(ResolveRequest(link.trim())),
            activity,
        )
        when (code) {
            200 -> ApiHttp.json.decodeFromString<ResolveResponse>(body)
            401 -> throw IllegalStateException("Hết phiên đăng nhập (401)")
            400 -> throw IllegalStateException(
                ApiHttp.readErrorMessage(body) ?: "Link không hợp lệ (400)"
            )
            404 -> throw IllegalStateException(
                ApiHttp.readErrorMessage(body) ?: "Không tìm thấy (link sai hoặc chưa share)"
            )
            else -> throw IllegalStateException(
                ApiHttp.readErrorMessage(body) ?: "Lỗi: HTTP $code"
            )
        }
    }

    /**
     * Copy 1 file vào Drive của user (server-side).
     * @throws CopyScopeException khi token không đủ quyền (D7) — app hiện hướng dẫn.
     * @throws IllegalStateException cho các lỗi khác.
     */
    suspend fun copy(
        sourceId: String,
        destName: String = "",
        activity: android.app.Activity? = null,
    ): CopyResponse = withContext(Dispatchers.IO) {
        val (code, body) = post(
            "/api/dac/copy",
            ApiHttp.json.encodeToString(CopyRequest(sourceId, destName)),
            activity,
        )
        when (code) {
            200 -> ApiHttp.json.decodeFromString<CopyResponse>(body)
            401 -> throw IllegalStateException("Hết phiên đăng nhập (401)")
            400, 404, 429, 502 -> throw IllegalStateException(
                ApiHttp.readErrorMessage(body) ?: "Copy lỗi: HTTP $code"
            )
            403 -> {
                val errResp = runCatching {
                    ApiHttp.json.decodeFromString<ErrorResponse>(body)
                }.getOrNull()
                if (errResp?.error == "insufficient_scope") {
                    // D7: token drive.readonly không đủ quyền copy file share.
                    throw CopyScopeException(
                        errResp.details.ifEmpty {
                            "Không đủ quyền copy file này. " +
                                "Vào Cài đặt → ngắt kết nối Drive → kết nối lại " +
                                "và cấp quyền đầy đủ khi hệ thống hỏi."
                        }
                    )
                }
                throw IllegalStateException(
                    errResp?.error?.ifEmpty { null } ?: "Bị từ chối (403)"
                )
            }
            else -> throw IllegalStateException(
                ApiHttp.readErrorMessage(body) ?: "Copy lỗi: HTTP $code"
            )
        }
    }
}

/**
 * Lỗi scope khi copy (D7) — app bắt riêng để hiện hướng dẫn cấp quyền,
 * không hiện như lỗi chung chung.
 */
class CopyScopeException(message: String) : IllegalStateException(message)
