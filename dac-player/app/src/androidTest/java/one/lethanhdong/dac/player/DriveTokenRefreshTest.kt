package one.lethanhdong.dac.player

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.6: test logic refresh Drive token + retry 1 lần — KHÔNG dùng token thật,
 * không gọi mạng. FakeDriveAuthManager giả lập AccountManager.
 */
@RunWith(AndroidJUnit4::class)
class DriveTokenRefreshTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    /** Giả lập AccountManager: token đầu hỏng, sau invalidate() trả token mới. */
    private class FakeDriveAuthManager(context: Context) : DriveAuthManager(context) {
        var tokens = mutableListOf("bad-token", "good-token")
        val invalidated = mutableListOf<String>()
        var getTokenCalls = 0

        override suspend fun getToken(activity: android.app.Activity?): String {
            getTokenCalls++
            return tokens.removeAt(0)  // removeFirst() là Java 21 API, không có trên emulator cũ
        }

        override fun invalidateToken(token: String) {
            invalidated.add(token)
        }
    }

    @Test
    fun withDriveToken_refreshOnceThenSucceeds() = runTest {
        val fake = FakeDriveAuthManager(context)
        val client = MusicApiClient(context, driveAuthManager = fake)

        var attempts = 0
        val result = client.withDriveToken { token ->
            attempts++
            if (token == "bad-token") throw DriveTokenInvalidException()
            "ok:$token"
        }

        assertEquals("ok:good-token", result)
        assertEquals(2, attempts)
        // Token hỏng bị invalidate đúng 1 lần, token mới không bị invalidate
        assertEquals(listOf("bad-token"), fake.invalidated)
        assertEquals(2, fake.getTokenCalls)
    }

    @Test
    fun withDriveToken_double401_throwsAndInvalidatesBoth() = runTest {
        val fake = FakeDriveAuthManager(context)
        // Cả 2 token đều hỏng
        fake.tokens = mutableListOf("bad-1", "bad-2")
        val client = MusicApiClient(context, driveAuthManager = fake)

        try {
            client.withDriveToken { throw DriveTokenInvalidException() }
            fail("Phải throw DriveTokenInvalidException")
        } catch (e: DriveTokenInvalidException) {
            // đúng
        }
        // Cả 2 token đều bị invalidate, chỉ thử đúng 2 lần (không retry vô hạn)
        assertEquals(listOf("bad-1", "bad-2"), fake.invalidated)
        assertEquals(2, fake.getTokenCalls)
    }

    @Test
    fun withDriveToken_noError_noRefresh() = runTest {
        val fake = FakeDriveAuthManager(context)
        val client = MusicApiClient(context, driveAuthManager = fake)

        val result = client.withDriveToken { token -> "ok:$token" }

        assertEquals("ok:bad-token", result)
        assertTrue(fake.invalidated.isEmpty())
        assertEquals(1, fake.getTokenCalls)
    }
}
