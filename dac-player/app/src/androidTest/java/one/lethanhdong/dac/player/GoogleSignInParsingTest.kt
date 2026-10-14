package one.lethanhdong.dac.player

import android.content.Context
import android.os.Bundle
import androidx.credentials.CustomCredential
import androidx.credentials.PasswordCredential
import androidx.test.core.app.ApplicationProvider
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
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
}
