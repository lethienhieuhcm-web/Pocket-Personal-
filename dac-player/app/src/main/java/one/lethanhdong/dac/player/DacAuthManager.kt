package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * DAC Auth riêng — tách khỏi web auth (Chốt 2026-10-18).
 *
 * API:
 * - POST /api/dac/auth/login {email, password} → {accessToken, refreshToken, expiresIn}
 * - POST /api/dac/auth/refresh {refreshToken} → {accessToken, refreshToken, expiresIn} (rotation)
 * - POST /api/dac/auth/logout → {ok}
 *
 * Access token: 1h, Refresh token: 30d.
 * Token lưu vào EncryptedSharedPreferences "dac_auth_enc".
 */
class DacAuthManager(
    private val context: Context,
    private val baseUrl: String = "https://lethanhdong.one",
) {
    private val prefs by lazy {
        EncryptedPrefs.open(
            context,
            plainName = "dac_auth",
            encryptedName = "dac_auth_enc",
            migrateKeys = emptyMap(),
        )
    }

    private val json = Json { ignoreUnknownKeys = true }

    @Serializable
    private data class LoginRequest(val email: String, val password: String)

    @Serializable
    private data class RefreshRequest(val refreshToken: String)

    @Serializable
    private data class AuthResponse(
        val accessToken: String = "",
        val refreshToken: String = "",
        val expiresIn: Long = 0,
        val email: String = ""
    )

    fun isLoggedIn(): Boolean = accessToken() != null

    fun accessToken(): String? {
        return prefs.getString("dac_access_token", null)?.ifEmpty { null }
    }

    fun email(): String? {
        return prefs.getString("dac_email", null)?.ifEmpty { null }
    }

    /**
     * Đăng nhập DAC — trả về email nếu thành công, null nếu sai.
     */
    suspend fun login(email: String, password: String): String? = withContext(Dispatchers.IO) {
        try {
            val body = json.encodeToString(LoginRequest(email.trim().lowercase(), password))
                .toRequestBody("application/json".toMediaType())

            val request = Request.Builder()
                .url("$baseUrl/api/dac/auth/login")
                .post(body)
                .build()

            ApiHttp.client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) return@withContext null
                val respBody = resp.body?.string() ?: return@withContext null
                val auth = json.decodeFromString<AuthResponse>(respBody)

                prefs.edit()
                    .putString("dac_access_token", auth.accessToken)
                    .putString("dac_refresh_token", auth.refreshToken)
                    .putString("dac_email", auth.email)
                    .putLong("dac_token_exp", System.currentTimeMillis() + auth.expiresIn * 1000)
                    .apply()

                return@withContext auth.email
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Refresh token — tự động khi access hết hạn.
     * Trả về true nếu refresh thành công.
     */
    suspend fun refresh(): Boolean = withContext(Dispatchers.IO) {
        try {
            val refreshToken = prefs.getString("dac_refresh_token", null) ?: return@withContext false

            val body = json.encodeToString(RefreshRequest(refreshToken))
                .toRequestBody("application/json".toMediaType())

            val request = Request.Builder()
                .url("$baseUrl/api/dac/auth/refresh")
                .post(body)
                .build()

            ApiHttp.client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) {
                    // Refresh hết hạn → phải login lại
                    clear()
                    return@withContext false
                }
                val respBody = resp.body?.string() ?: return@withContext false
                val auth = json.decodeFromString<AuthResponse>(respBody)

                prefs.edit()
                    .putString("dac_access_token", auth.accessToken)
                    .putString("dac_refresh_token", auth.refreshToken)
                    .putLong("dac_token_exp", System.currentTimeMillis() + auth.expiresIn * 1000)
                    .apply()

                return@withContext true
            }
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Lấy access token hợp lệ — tự refresh nếu hết hạn.
     */
    suspend fun validAccessToken(): String? {
        val token = accessToken() ?: return null
        val exp = prefs.getLong("dac_token_exp", 0)

        // Còn hạn > 5 phút → dùng luôn
        if (System.currentTimeMillis() < exp - 5 * 60 * 1000) {
            return token
        }

        // Hết hạn → refresh
        return if (refresh()) accessToken() else null
    }

    /**
     * Đăng xuất — thu hồi cả 2 token.
     */
    suspend fun logout() = withContext(Dispatchers.IO) {
        try {
            val access = accessToken()
            val refresh = prefs.getString("dac_refresh_token", null)

            if (access != null) {
                val body = json.encodeToString(RefreshRequest(refresh ?: ""))
                    .toRequestBody("application/json".toMediaType())

                val request = Request.Builder()
                    .url("$baseUrl/api/dac/auth/logout")
                    .header("Authorization", "Bearer $access")
                    .post(body)
                    .build()

                ApiHttp.client.newCall(request).execute().close()
            }
        } catch (e: Exception) {
            // bỏ qua
        } finally {
            clear()
        }
    }

    private fun clear() {
        prefs.edit()
            .remove("dac_access_token")
            .remove("dac_refresh_token")
            .remove("dac_email")
            .remove("dac_token_exp")
            .apply()
    }
}
