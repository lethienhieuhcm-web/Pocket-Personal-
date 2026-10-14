package one.lethanhdong.dac.player

import kotlinx.serialization.json.Json
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

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
        .addInterceptor(RetryInterceptor())
        .build()

    val json: Json = Json { ignoreUnknownKeys = true }

    /**
     * 4.3: Tính thời gian chờ backoff (ms) cho lần thử [attempt] (1-based).
     * Exponential 1s → 2s → 4s, cap 8s, + jitter 0–500ms.
     * Tách ra để unit test được.
     */
    fun backoffDelayMs(attempt: Int): Long =
        min(1000L * (1L shl (attempt - 1)), 8000L) + Random.nextLong(501)

    /**
     * 4.3: Retry interceptor — chỉ retry GET/HEAD (idempotent) khi gặp
     * 429 (rate limit) hoặc 503 (tạm quá tải). POST (sync/copy/...) không
     * retry mù để tránh ghi trùng.
     */
    private class RetryInterceptor : Interceptor {
        override fun intercept(chain: Interceptor.Chain): Response {
            val req = chain.request()
            if (req.method != "GET" && req.method != "HEAD") {
                return chain.proceed(req)
            }
            var last: Response? = null
            repeat(3) { attempt ->
                val resp = chain.proceed(req)
                if (resp.code != 429 && resp.code != 503) return resp
                last?.close()
                last = resp
                if (attempt < 2) {
                    Thread.sleep(backoffDelayMs(attempt + 1))
                }
            }
            return last!!
        }
    }

    /** Đọc message lỗi từ error body JSON {"error": "..."} — null nếu không parse được. */
    fun readErrorMessage(body: String?): String? {
        if (body.isNullOrBlank()) return null
        return runCatching {
            json.decodeFromString<ErrorResponse>(body).error.ifEmpty { null }
        }.getOrDefault(null)
    }
}
