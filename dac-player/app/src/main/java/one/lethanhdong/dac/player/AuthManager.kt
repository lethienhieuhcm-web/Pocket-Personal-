package one.lethanhdong.dac.player

import android.content.Context
import android.util.DisplayMetrics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.TimeZone

/**
 * Quản lý đăng nhập Pocket Personal — plan "dac" D2 + dac-app Phase 1.2/1.3.
 *
 * API: POST /api/auth/login {email, password, fp} → {token, email, role, ...}
 * (verify từ worker/src/auth.js handleLogin, 2026-10-12)
 *
 * 1.3: login gửi kèm `fp` {screen, tz, lang} để Worker làm lock key
 * per-(email+fingerprint) (Chốt C 1.1); login/register hiện đúng message
 * server cho 429; logout() gọi POST /api/auth/logout rồi mới xoá local.
 *
 * Token lưu vào EncryptedSharedPreferences "pp_auth_enc" key "session_token" (Phase 1.2) —
 * MusicApiClient đọc từ đây qua [token].
 * Migrate 1 lần: plain "pp_auth" cũ (key "authToken" + "authEmail") → encrypted
 * ("session_token" + "authEmail") → xoá file plain (xem [EncryptedPrefs]).
 * Lần đầu mở EncryptedSharedPreferences chạy Keystore I/O đồng bộ (vài chục ms, 1 lần)
 * — chấp nhận theo pattern chuẩn của Google (không fallback về plain).
 */
class AuthManager(
    private val context: Context,
    private val baseUrl: String = "https://lethanhdong.one",
) {
    private val prefs by lazy {
        EncryptedPrefs.open(
            context,
            plainName = "pp_auth",
            encryptedName = "pp_auth_enc",
            migrateKeys = mapOf("authToken" to "session_token", "authEmail" to "authEmail"),
        )
    }

    fun isLoggedIn(): Boolean = token() != null

    fun token(): String? {
        val raw = prefs.getString("session_token", null) ?: return null
        return raw.trim().removeSurrounding("\"").ifEmpty { null }
    }

    fun email(): String? = prefs.getString("authEmail", null)

    /**
     * Fingerprint thiết bị gửi kèm login — Worker (auth.js makeFingerprint)
     * đọc `fp: {screen, tz, lang}` từ body để làm lock key per-(email+fingerprint)
     * (Chốt C 1.1). Cùng format web gửi. Không có fp → Worker chỉ dựa UA.
     */
    private fun fingerprintJson(): JSONObject {
        val dm: DisplayMetrics = context.resources.displayMetrics
        return JSONObject()
            .put("screen", "${dm.widthPixels}x${dm.heightPixels}")
            .put("tz", TimeZone.getDefault().id)
            .put("lang", Locale.getDefault().language)
    }

    /** Đọc message lỗi từ error body JSON {"error": "..."} — null nếu không parse được. */
    private fun readErrorMessage(conn: HttpURLConnection): String? {
        return runCatching {
            val text = conn.errorStream?.bufferedReader()?.readText().orEmpty()
            if (text.isBlank()) return@runCatching null
            JSONObject(text).optString("error", "").ifEmpty { null }
        }.getOrDefault(null)
    }

    /** Đăng nhập. True nếu thành công, throw nếu sai credentials / lỗi mạng. */
    suspend fun login(email: String, password: String): Boolean =
        withContext(Dispatchers.IO) {
            val conn = URL("$baseUrl/api/auth/login").openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                val body = JSONObject()
                    .put("email", email.trim().lowercase())
                    .put("password", password)
                    .put("fp", fingerprintJson())
                    .toString()
                conn.outputStream.bufferedWriter().use { it.write(body) }

                val code = conn.responseCode
                if (code == 401) throw IllegalStateException("Sai email hoặc mật khẩu")
                if (code == 429) {
                    // 1.1 Chốt C: lock 15 phút sau 5 lần sai — hiện đúng message server
                    throw IllegalStateException(
                        readErrorMessage(conn)
                            ?: "Quá nhiều lần đăng nhập sai. Thử lại sau 15 phút."
                    )
                }
                if (code != 200) {
                    throw IllegalStateException(
                        readErrorMessage(conn) ?: "Lỗi đăng nhập: HTTP $code"
                    )
                }

                val json = JSONObject(conn.inputStream.bufferedReader().readText())
                val token = json.getString("token")
                prefs.edit()
                    .putString("session_token", token)
                    .putString("authEmail", json.optString("email", email))
                    .apply()
                true
            } finally {
                conn.disconnect()
            }
        }

    /** Đăng ký tài khoản mới. True nếu thành công, throw nếu lỗi. */
    suspend fun register(email: String, password: String): Boolean =
        withContext(Dispatchers.IO) {
            val conn = URL("$baseUrl/api/auth/register").openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                val body = JSONObject()
                    .put("email", email.trim().lowercase())
                    .put("password", password)
                    .toString()
                conn.outputStream.bufferedWriter().use { it.write(body) }

                val code = conn.responseCode
                if (code == 409) throw IllegalStateException("Email đã đăng ký, vui lòng đăng nhập")
                if (code == 429) {
                    throw IllegalStateException(
                        readErrorMessage(conn)
                            ?: "Đăng ký quá nhiều. Thử lại sau."
                    )
                }
                if (code == 400) {
                    throw IllegalStateException(
                        readErrorMessage(conn) ?: "Thông tin đăng ký không hợp lệ"
                    )
                }
                if (code != 200) throw IllegalStateException("Lỗi đăng ký: HTTP $code")
                true
            } finally {
                conn.disconnect()
            }
        }

    /**
     * Đăng xuất — plan dac-app 1.3: POST /api/auth/logout (xoá session server)
     * + xoá storage local. Luôn xoá local kể cả khi gọi server lỗi
     * (mất mạng / token đã hết hạn) — user vẫn thoát được khỏi máy này.
     */
    suspend fun logout() {
        val token = token()
        if (token != null) {
            try {
                withContext(Dispatchers.IO) {
                    val conn = URL("$baseUrl/api/auth/logout").openConnection() as HttpURLConnection
                    try {
                        conn.requestMethod = "POST"
                        conn.setRequestProperty("Authorization", "Bearer $token")
                        conn.connectTimeout = 10000
                        conn.readTimeout = 10000
                        conn.responseCode // kích hoạt request, bỏ qua kết quả
                    } finally {
                        conn.disconnect()
                    }
                }
            } catch (e: Exception) {
                // Lỗi server/mạng → bỏ qua, vẫn xoá local bên dưới
            }
        }
        prefs.edit().remove("session_token").remove("authEmail").apply()
    }
}
