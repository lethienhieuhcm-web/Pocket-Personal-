package one.lethanhdong.dac.player

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.7: test parse JSON sessions + deviceLabel — không gọi mạng.
 */
@RunWith(AndroidJUnit4::class)
class SessionsTest {

    @Test
    fun parseSessionsResponse() {
        val json = """
            {"sessions":[
              {"token_prefix":"abc123","current":true,"ip":"1.2.3.4",
               "ua":"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
               "created_at":1729000000000,"last_active":1729000100000},
              {"token_prefix":"def456","current":false,"ip":"5.6.7.8",
               "ua":"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
               "created_at":1728900000000,"last_active":1728900100000}
            ]}
        """.trimIndent()
        val resp = ApiHttp.json.decodeFromString(SessionsResponse.serializer(), json)
        assertEquals(2, resp.sessions.size)

        val s1 = resp.sessions[0]
        assertEquals("abc123", s1.token_prefix)
        assertTrue(s1.current)
        assertEquals("1.2.3.4", s1.ip)
        assertEquals(1729000100000L, s1.last_active)

        val s2 = resp.sessions[1]
        assertFalse(s2.current)
        assertEquals("def456", s2.token_prefix)
    }

    @Test
    fun deviceLabel_android() {
        val s = LoginSession(
            ua = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36",
        )
        assertEquals("Android · Trình duyệt", s.deviceLabel())
    }

    @Test
    fun deviceLabel_ios() {
        val s = LoginSession(
            ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
        )
        assertEquals("iOS · Trình duyệt", s.deviceLabel())
    }

    @Test
    fun deviceLabel_unknown() {
        val s = LoginSession(ua = "")
        assertEquals("Thiết bị · Trình duyệt", s.deviceLabel())
    }

    @Test
    fun parseEmptySessions() {
        val resp = ApiHttp.json.decodeFromString(
            SessionsResponse.serializer(), """{"sessions":[]}"""
        )
        assertTrue(resp.sessions.isEmpty())
    }
}
