package one.lethanhdong.dac.player

import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * HTTP + JSON dùng chung cho mọi API call — plan dac-app 1.4.
 *
 * Một OkHttpClient duy nhất (connection pool + timeouts) cho AuthManager
 * và MusicApiClient, thay cho HttpURLConnection rời rạc trước đây.
 * Một Json duy nhất với ignoreUnknownKeys (Worker có thể thêm field mới
 * mà app chưa biết — app không crash).
 */
object ApiHttp {
    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    val json: Json = Json { ignoreUnknownKeys = true }

    /** Đọc message lỗi từ error body JSON {"error": "..."} — null nếu không parse được. */
    fun readErrorMessage(body: String?): String? {
        if (body.isNullOrBlank()) return null
        return runCatching {
            json.decodeFromString<ErrorResponse>(body).error.ifEmpty { null }
        }.getOrDefault(null)
    }
}
