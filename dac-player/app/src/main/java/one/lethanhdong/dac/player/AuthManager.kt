package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Quản lý đăng nhập Pocket Personal — plan "dac" D2.
 *
 * API: POST /api/auth/login {email, password} → {token, email, role, ...}
 * (verify từ worker/src/auth.js handleLogin, 2026-10-12)
 *
 * Token lưu vào SharedPreferences "pp_auth" key "authToken" —
 * MusicApiClient đọc từ đây.
 */
class AuthManager(
    private val context: Context,
    private val baseUrl: String = "https://lethanhdong.one",
) {
    private val prefs by lazy {
        context.getSharedPreferences("pp_auth", Context.MODE_PRIVATE)
    }

    fun isLoggedIn(): Boolean = token() != null

    fun token(): String? {
        val raw = prefs.getString("authToken", null) ?: return null
        return raw.trim().removeSurrounding("\"").ifEmpty { null }
    }

    fun email(): String? = prefs.getString("authEmail", null)

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
                    .toString()
                conn.outputStream.bufferedWriter().use { it.write(body) }

                val code = conn.responseCode
                if (code == 401) throw IllegalStateException("Sai email hoặc mật khẩu")
                if (code != 200) throw IllegalStateException("Lỗi đăng nhập: HTTP $code")

                val json = JSONObject(conn.inputStream.bufferedReader().readText())
                val token = json.getString("token")
                prefs.edit()
                    .putString("authToken", token)
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
                if (code == 400) {
                    val err = runCatching {
                        JSONObject(conn.errorStream?.bufferedReader()?.readText() ?: "")
                            .optString("error", "")
                    }.getOrDefault("")
                    throw IllegalStateException(err.ifEmpty { "Thông tin đăng ký không hợp lệ" })
                }
                if (code != 200) throw IllegalStateException("Lỗi đăng ký: HTTP $code")
                true
            } finally {
                conn.disconnect()
            }
        }

    fun logout() {
        prefs.edit().remove("authToken").remove("authEmail").apply()
    }
}
