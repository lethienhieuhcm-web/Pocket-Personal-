package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Client gọi Worker API để lấy danh sách nhạc và URL stream từ R2.
 *
 * Kiến trúc plan "dac" (đã Chốt):
 *   [FLAC trên R2] → [Worker API: list + auth] → [App] → [USB DAC bit-perfect]
 *
 * API contract (D3 sẽ implement phía Worker, mirror theo /api/drive/... đang có):
 *   GET /api/dac/music          → {files:[{id,name,size,mimeType}]} (cần Bearer token)
 *   GET /api/dac/stream/{id}    → {url}  (signed R2 URL, cần Bearer token)
 *
 * Token đọc từ AuthManager (SharedPreferences "pp_auth").
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

    private val auth by lazy { AuthManager(context, baseUrl) }

    private fun authToken(): String? = auth.token()

    private suspend fun get(path: String): JSONObject = withContext(Dispatchers.IO) {
        val token = authToken() ?: throw IllegalStateException("Chưa đăng nhập")
        val conn = URL(baseUrl + path).openConnection() as HttpURLConnection
        try {
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            val code = conn.responseCode
            if (code == 401) throw IllegalStateException("Hết phiên đăng nhập (401)")
            if (code != 200) throw IllegalStateException("API lỗi: HTTP $code")
            JSONObject(conn.inputStream.bufferedReader().readText())
        } finally {
            conn.disconnect()
        }
    }

    /** Lấy danh sách nhạc từ R2 qua Worker. */
    suspend fun listMusic(): List<Track> {
        val json = get("/api/dac/music")
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

    /** Lấy signed R2 URL để stream. ExoPlayer đọc trực tiếp, hỗ trợ Range seek. */
    suspend fun streamUrl(id: String): String {
        val json = get("/api/dac/stream/$id")
        return json.getString("url")
    }
}
