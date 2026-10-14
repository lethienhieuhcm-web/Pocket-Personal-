package one.lethanhdong.dac.player

import android.content.Context
import android.util.DisplayMetrics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.Locale
import java.util.TimeZone

/**
 * Quản lý đăng nhập Pocket Personal — plan "dac" D2 + dac-app Phase 1.2/1.3/1.4.
 *
 * API: POST /api/auth/login {email, password, fp} → {token, email, role, ...}
 * (verify từ worker/src/auth.js handleLogin, 2026-10-12)
 *
 * 1.3: login gửi kèm `fp` {screen, tz, lang} để Worker làm lock key
 * per-(email+fingerprint) (Chốt C 1.1); login/register hiện đúng message
 * server cho 429; logout() gọi POST /api/auth/logout rồi mới xoá local.
 * 1.4: HttpURLConnection → OkHttp (ApiHttp.client), JSONObject → kotlinx.serialization.
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
    private fun fingerprint(): Fingerprint {
        val dm: DisplayMetrics = context.resources.displayMetrics
        return Fingerprint(
            screen = "${dm.widthPixels}x${dm.heightPixels}",
            tz = TimeZone.getDefault().id,
            lang = Locale.getDefault().language,
        )
    }

    private fun jsonBody(value: String): RequestBody =
        value.toRequestBody("application/json".toMediaType())

    /** Đăng nhập. True nếu thành công, throw nếu sai credentials / lỗi mạng. */
    suspend fun login(email: String, password: String): Boolean =
        withContext(Dispatchers.IO) {
            val body = ApiHttp.json.encodeToString(
                LoginRequest(email.trim().lowercase(), password, fingerprint())
            )
            val request = Request.Builder()
                .url("$baseUrl/api/auth/login")
                .post(jsonBody(body))
                .build()
            ApiHttp.client.newCall(request).execute().use { resp ->
                val respBody = resp.body?.string().orEmpty()
                when (resp.code) {
                    401 -> throw IllegalStateException("Sai email hoặc mật khẩu")
                    // 2.2: email chưa verify → exception riêng để UI hiện nút gửi lại
                    403 -> {
                        val err = try {
                            ApiHttp.json.decodeFromString<ErrorResponse>(respBody)
                        } catch (e: Exception) { null }
                        if (err?.error == "email_not_verified") throw EmailNotVerifiedException()
                        throw IllegalStateException(
                            err?.error ?: "Lỗi đăng nhập: HTTP ${resp.code}"
                        )
                    }
                    429 -> throw IllegalStateException(
                        // 1.1 Chốt C: lock 15 phút sau 5 lần sai — hiện đúng message server
                        ApiHttp.readErrorMessage(respBody)
                            ?: "Quá nhiều lần đăng nhập sai. Thử lại sau 15 phút."
                    )
                    200 -> {
                        val auth = ApiHttp.json.decodeFromString<AuthResponse>(respBody)
                        prefs.edit()
                            .putString("session_token", auth.token)
                            .putString("authEmail", auth.email.ifEmpty { email })
                            .apply()
                        true
                    }
                    else -> throw IllegalStateException(
                        ApiHttp.readErrorMessage(respBody) ?: "Lỗi đăng nhập: HTTP ${resp.code}"
                    )
                }
            }
        }

    /**
     * 2.4: Lưu session từ Google Sign-In (đã verify ID token ở Worker).
     *
     * 4.3: dùng commit() đồng bộ thay vì apply() — sau khi hàm return,
     * session CHẮC CHẮN đã ghi đĩa. apply() ghi async: test @Before
     * deleteSharedPreferences có thể chạy trước khi ghi xong, rồi write
     * muộn tạo lại file → test sau thấy session "ma" (flaky).
     * Caller đã ở background thread (sau network call) nên commit() an toàn.
     */
    fun saveGoogleSession(token: String, email: String) {
        prefs.edit()
            .putString("session_token", token)
            .putString("authEmail", email)
            .commit()
    }

    /**
     * Đăng ký tài khoản mới. Trả về RegisterResponse (có needsVerification).
     * 2.2: nếu needsVerification=true, user phải bấm link trong email trước khi login.
     */
    suspend fun register(email: String, password: String): RegisterResponse =
        withContext(Dispatchers.IO) {
            val body = ApiHttp.json.encodeToString(
                RegisterRequest(email.trim().lowercase(), password)
            )
            val request = Request.Builder()
                .url("$baseUrl/api/auth/register")
                .post(jsonBody(body))
                .build()
            ApiHttp.client.newCall(request).execute().use { resp ->
                val respBody = resp.body?.string().orEmpty()
                when (resp.code) {
                    200 -> ApiHttp.json.decodeFromString<RegisterResponse>(respBody)
                    409 -> throw IllegalStateException("Email đã đăng ký, vui lòng đăng nhập")
                    429 -> throw IllegalStateException(
                        ApiHttp.readErrorMessage(respBody) ?: "Đăng ký quá nhiều. Thử lại sau."
                    )
                    400 -> throw IllegalStateException(
                        ApiHttp.readErrorMessage(respBody) ?: "Thông tin đăng ký không hợp lệ"
                    )
                    else -> throw IllegalStateException(
                        ApiHttp.readErrorMessage(respBody) ?: "Lỗi đăng ký: HTTP ${resp.code}"
                    )
                }
            }
        }

    /**
     * 2.2: Gửi lại email xác nhận. Luôn thành công (server không tiết lộ email có tồn tại).
     */
    suspend fun resendVerification(email: String): Boolean =
        withContext(Dispatchers.IO) {
            val body = ApiHttp.json.encodeToString(
                mapOf("email" to email.trim().lowercase())
            )
            val request = Request.Builder()
                .url("$baseUrl/api/auth/resend-verification")
                .post(jsonBody(body))
                .build()
            ApiHttp.client.newCall(request).execute().use { resp ->
                resp.code == 200
            }
        }

    /**
     * 2.2: Quên mật khẩu — gửi email reset link. Luôn thành công để chống enumeration.
     */
    suspend fun forgotPassword(email: String): Boolean =
        withContext(Dispatchers.IO) {
            val body = ApiHttp.json.encodeToString(
                mapOf("email" to email.trim().lowercase())
            )
            val request = Request.Builder()
                .url("$baseUrl/api/auth/forgot-password")
                .post(jsonBody(body))
                .build()
            ApiHttp.client.newCall(request).execute().use { resp ->
                resp.code == 200
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
                    val request = Request.Builder()
                        .url("$baseUrl/api/auth/logout")
                        .header("Authorization", "Bearer $token")
                        .post(ByteArray(0).toRequestBody(null))
                        .build()
                    ApiHttp.client.newCall(request).execute().use { it.body?.close() }
                }
            } catch (e: Exception) {
                // Lỗi server/mạng → bỏ qua, vẫn xoá local bên dưới
            }
        }
        prefs.edit().remove("session_token").remove("authEmail").apply()
    }
}
