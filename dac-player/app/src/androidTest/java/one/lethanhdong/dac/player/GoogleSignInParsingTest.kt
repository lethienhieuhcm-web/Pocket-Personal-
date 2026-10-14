package one.lethanhdong.dac.player

import android.content.Context
import android.os.Bundle
import androidx.credentials.CustomCredential
import androidx.credentials.PasswordCredential
import androidx.test.core.app.ApplicationProvider
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4

/**
 * 2.4: test phần parse credential của Google Sign-In — không cần tài khoản
 * Google thật, không mở bottom sheet.
 *
 * Lưu ý: các key BUNDLE_KEY_* của GoogleIdTokenCredential là internal trong
 * lib googleid 1.1.1, nên test dùng đúng giá trị string đã verify từ binary
 * chính thức (googleid-1.1.1.aar trên dl.google.com), không đoán.
 */
private const val BUNDLE_KEY_ID =
    "com.google.android.libraries.identity.googleid.BUNDLE_KEY_ID"
private const val BUNDLE_KEY_ID_TOKEN =
    "com.google.android.libraries.identity.googleid.BUNDLE_KEY_ID_TOKEN"

@RunWith(AndroidJUnit4::class)
class GoogleSignInParsingTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val manager = GoogleSignInManager(
        context,
        baseUrl = "https://example.test",
        webClientId = "test-web-client-id.apps.googleusercontent.com",
    )

    private fun googleCredential(idToken: String?): CustomCredential {
        val data = Bundle().apply {
            putString(BUNDLE_KEY_ID, "user@gmail.com")
            if (idToken != null) {
                putString(BUNDLE_KEY_ID_TOKEN, idToken)
            }
        }
        return CustomCredential(
            type = GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL,
            data = data,
        )
    }

    @Test
    fun validGoogleCredential_returnsIdToken() {
        val cred = googleCredential("header.payload.signature")
        assertEquals("header.payload.signature", manager.extractGoogleIdToken(cred))
    }

    @Test
    fun wrongType_returnsNull() {
        val cred = CustomCredential(
            type = "some.other.type",
            data = Bundle(),
        )
        assertNull(manager.extractGoogleIdToken(cred))
    }

    @Test
    fun passwordCredential_returnsNull() {
        val cred = PasswordCredential("user", "pass")
        assertNull(manager.extractGoogleIdToken(cred))
    }

    @Test
    fun missingIdTokenInBundle_returnsNull() {
        val cred = googleCredential(null)
        assertNull(manager.extractGoogleIdToken(cred))
    }

    @Test
    fun missingIdInBundle_returnsNull() {
        val cred = CustomCredential(
            type = GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL,
            data = Bundle().apply {
                putString(BUNDLE_KEY_ID_TOKEN, "header.payload.signature")
            },
        )
        assertNull(manager.extractGoogleIdToken(cred))
    }

    @Test
    fun emptyDataBundle_returnsNull() {
        val cred = CustomCredential(
            type = GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL,
            data = Bundle(),
        )
        assertNull(manager.extractGoogleIdToken(cred))
    }

    @Test
    fun googleLoginResponse_parsesJson() {
        val resp = ApiHttp.json.decodeFromString<GoogleSignInManager.GoogleLoginResponse>(
            """{"token":"sess-abc","email":"user@gmail.com","role":"user"}"""
        )
        assertEquals("sess-abc", resp.token)
        assertEquals("user@gmail.com", resp.email)
    }

    @Test
    fun googleLoginResponse_parsesJsonWithExtraKeys() {
        // Worker có thể trả thêm field; parser phải chịu được
        val resp = ApiHttp.json.decodeFromString<GoogleSignInManager.GoogleLoginResponse>(
            """{"token":"sess-abc","email":"user@gmail.com","role":"user","verified":true}"""
        )
        assertEquals("sess-abc", resp.token)
    }

    // ---- handleIdTokenResponse: 2.4 test phần an toàn (không cần mạng) ----

    private val auth = AuthManager(context, "https://example.test")

    @Before
    fun clearAuthState() {
        context.deleteSharedPreferences("pp_auth")
        context.deleteSharedPreferences("pp_auth_enc")
    }

    @Test
    fun response200_savesSessionAndReturnsLogin() {
        val login = manager.handleIdTokenResponse(
            200,
            """{"token":"sess-abc","email":"user@gmail.com","role":"user"}""",
        )
        assertEquals("sess-abc", login.token)
        assertTrue("session phải được lưu", auth.isLoggedIn())
        assertEquals("sess-abc", auth.token())
        assertEquals("user@gmail.com", auth.email())
    }

    @Test
    fun response200_invalidJson_throws() {
        try {
            manager.handleIdTokenResponse(200, "not-json")
            fail("phải throw khi body 200 không parse được")
        } catch (e: Exception) {
            assertFalse(auth.isLoggedIn())
        }
    }

    @Test
    fun response200_missingToken_throws() {
        try {
            manager.handleIdTokenResponse(200, """{"email":"user@gmail.com"}""")
            fail("phải throw khi thiếu token")
        } catch (e: Exception) {
            assertFalse(auth.isLoggedIn())
        }
    }

    @Test
    fun response401_mapsToInvalidTokenMessage() {
        try {
            manager.handleIdTokenResponse(401, """{"error":"invalid_token"}""")
            fail("phải throw cho 401")
        } catch (e: IllegalStateException) {
            assertEquals("Google token không hợp lệ", e.message)
        }
    }

    @Test
    fun response429_mapsToRateLimitMessage() {
        try {
            manager.handleIdTokenResponse(429, "")
            fail("phải throw cho 429")
        } catch (e: IllegalStateException) {
            assertEquals("Thử quá nhiều lần, đợi một lúc rồi thử lại", e.message)
        }
    }

    @Test
    fun response500_withServerMessage_mapsToIt() {
        // Worker trả lỗi dạng {"error": "..."} — app phải hiện đúng message đó
        try {
            manager.handleIdTokenResponse(500, """{"error":"lỗi máy chủ"}""")
            fail("phải throw cho 500")
        } catch (e: IllegalStateException) {
            assertEquals("lỗi máy chủ", e.message)
        }
    }

    @Test
    fun response500_emptyBody_mapsToFallback() {
        try {
            manager.handleIdTokenResponse(500, "")
            fail("phải throw cho 500")
        } catch (e: IllegalStateException) {
            assertEquals("Đăng nhập Google thất bại", e.message)
        }
    }

    @Test
    fun blankWebClientId_throwsNotConfigured() {
        val unconfigured = GoogleSignInManager(
            context,
            baseUrl = "https://example.test",
            webClientId = "",
        )
        try {
            unconfigured.requireConfigured()
            fail("phải throw khi webClientId rỗng")
        } catch (e: IllegalStateException) {
            assertEquals("Đăng nhập Google chưa được cấu hình", e.message)
        }
    }
}
