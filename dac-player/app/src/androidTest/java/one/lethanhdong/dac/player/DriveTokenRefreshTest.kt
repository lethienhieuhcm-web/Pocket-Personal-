package one.lethanhdong.dac.player

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * dac-pass: withDriveToken chỉ truyền chuỗi rỗng — server lấy token từ D1
 * theo session email. Không còn logic refresh token ở client.
 */
@RunWith(AndroidJUnit4::class)
class DriveTokenRefreshTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    @Test
    fun withDriveToken_passesEmptyString() = runTest {
        val client = MusicApiClient(context)

        var receivedToken: String? = null
        val result = client.withDriveToken { token ->
            receivedToken = token
            "ok:$token"
        }

        assertEquals("", receivedToken)
        assertEquals("ok:", result)
    }

    @Test
    fun withDriveToken_propagatesException() = runTest {
        val client = MusicApiClient(context)

        try {
            client.withDriveToken { throw DriveTokenInvalidException() }
            org.junit.Assert.fail("Phải throw DriveTokenInvalidException")
        } catch (e: DriveTokenInvalidException) {
            // đúng — exception được propagate
        }
    }

    @Test
    fun withDriveToken_returnsBlockResult() = runTest {
        val client = MusicApiClient(context)

        val result = client.withDriveToken { 42 }
        assertEquals(42, result)
    }
}
