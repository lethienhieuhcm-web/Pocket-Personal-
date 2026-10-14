package one.lethanhdong.dac.player

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Unit test cho FolderListResponse (dac-app 4.1) — parse JSON từ
 * GET /api/dac/folders. Chạy trên emulator (androidTest).
 */
@RunWith(AndroidJUnit4::class)
class FolderListResponseTest {

    private val json = Json { ignoreUnknownKeys = true }

    private val sample = """
        {
          "parentId": "abc123",
          "parentName": "Nhạc",
          "breadcrumb": [
            {"id": "root", "name": "Drive của tôi"},
            {"id": "abc123", "name": "Nhạc"}
          ],
          "folders": [
            {"id": "f1", "name": "Album 1"},
            {"id": "f2", "name": "Album 2"}
          ],
          "tracks": [
            {"id": "t1", "name": "bai-hat.flac", "size": 12345678, "mimeType": "audio/flac"},
            {"id": "t2", "name": "intro.mp3", "size": 1234, "mimeType": "audio/mpeg"}
          ]
        }
    """.trimIndent()

    @Test
    fun parse_fullResponse() {
        val r = json.decodeFromString<FolderListResponse>(sample)
        assertEquals("abc123", r.parentId)
        assertEquals("Nhạc", r.parentName)
        assertEquals(2, r.breadcrumb.size)
        assertEquals("root", r.breadcrumb[0].id)
        assertEquals(2, r.folders.size)
        assertEquals("Album 1", r.folders[0].name)
        assertEquals(2, r.tracks.size)
        assertEquals("t1", r.tracks[0].id)
        assertEquals(12345678L, r.tracks[0].size)
    }

    @Test
    fun parse_emptyFolder() {
        val r = json.decodeFromString<FolderListResponse>(
            """{"parentId":"root","parentName":"Drive của tôi","breadcrumb":[],"folders":[],"tracks":[]}"""
        )
        assertTrue(r.folders.isEmpty())
        assertTrue(r.tracks.isEmpty())
        assertTrue(r.breadcrumb.isEmpty())
    }

    @Test
    fun parse_missingOptionalFields() {
        // Server có thể không gửi parentName — default phải chịu được
        val r = json.decodeFromString<FolderListResponse>(
            """{"parentId":"x","folders":[{"id":"f1"}],"tracks":[]}"""
        )
        assertEquals("", r.parentName)
        assertEquals("", r.folders[0].name)
    }
}
