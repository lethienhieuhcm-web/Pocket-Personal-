package one.lethanhdong.dac.player

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * 2.4: Google Sign-In bằng Credential Manager (API chuẩn của Google).
 * KHÔNG dùng GoogleSignInClient cũ (deprecated).
 *
 * Flow:
 * 1. Credential Manager hiện bottom sheet chọn tài khoản Google.
 * 2. Lấy Google ID token (JWT).
 * 3. POST lên Worker /api/auth/google/idtoken để verify và tạo session.
 *
 * @param webClientId Web OAuth client ID (dùng cho `aud` khi Worker verify).
 *                    Lấy từ Google Cloud Console > Credentials.
 */
class GoogleSignInManager(
    private val context: Context,
    private val baseUrl: String = "https://lethanhdong.one",
    private val webClientId: String,
) {
    @Serializable
    private data class IdTokenRequest(val idToken: String)

    @Serializable
    data class GoogleLoginResponse(
        val token: String,
        val email: String,
        val role: String = "user",
    )

    private val jsonMediaType = "application/json; charset=utf-8".toMediaType()
    private val credentialManager = CredentialManager.create(context)
    private val authManager = AuthManager(context, baseUrl)

    /**
     * Đăng nhập bằng Google. Mở bottom sheet chọn tài khoản.
     * @return session token nếu thành công.
     * @throws IllegalStateException với message user-friendly khi lỗi.
     */
    suspend fun signIn(): GoogleLoginResponse = withContext(Dispatchers.IO) {
        // 1. Lấy Google ID token qua Credential Manager
        val googleIdOption = GetGoogleIdOption.Builder()
            .setServerClientId(webClientId)
            .setFilterByAuthorizedAccounts(false) // hiện tất cả tài khoản Google trên máy
            .build()
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(googleIdOption)
            .build()

        val idToken = try {
            val result = credentialManager.getCredential(context, request)
            val credential = result.credential
            if (credential is GoogleIdTokenCredential) {
                credential.idToken
            } else {
                throw IllegalStateException("Không lấy được Google ID token")
            }
        } catch (e: NoCredentialException) {
            throw IllegalStateException("Không tìm thấy tài khoản Google trên máy")
        } catch (e: GetCredentialException) {
            // User hủy hoặc lỗi khác
            throw IllegalStateException("Đăng nhập Google bị hủy")
        }

        // 2. Gửi ID token lên Worker để verify và tạo session
        val body = ApiHttp.json.encodeToString(IdTokenRequest(idToken))
        val req = Request.Builder()
            .url("$baseUrl/api/auth/google/idtoken")
            .post(body.toRequestBody(jsonMediaType))
            .build()

        ApiHttp.client.newCall(req).execute().use { resp ->
            val respBody = resp.body?.string().orEmpty()
            when (resp.code) {
                200 -> {
                    val loginResp = ApiHttp.json.decodeFromString<GoogleLoginResponse>(respBody)
                    // Lưu session như login thường
                    authManager.saveGoogleSession(loginResp.token, loginResp.email)
                    loginResp
                }
                401 -> throw IllegalStateException("Google token không hợp lệ")
                429 -> throw IllegalStateException("Thử quá nhiều lần, đợi một lúc rồi thử lại")
                else -> throw IllegalStateException(
                    ApiHttp.readErrorMessage(respBody) ?: "Đăng nhập Google thất bại"
                )
            }
        }
    }
}
