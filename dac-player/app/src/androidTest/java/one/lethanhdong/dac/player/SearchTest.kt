package one.lethanhdong.dac.player

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.8: test parse JSON search + map sang Track — không gọi mạng.
 */
@RunWith(AndroidJUnit4::class)
class SearchTest {

    @Test
    fun parseSearchResponse_withArtist() {
        val json = """
            {"files":[
              {"id":"f1","name":"Taylor Swift - Love Story.mp3",
               "artist":"Taylor Swift","title":"Love Story",
               "size":5000,"mimeType":"audio/mpeg"},
              {"id":"f2","name":"love me do.flac",
               "artist":"","title":"love me do",
               "size":6000,"mimeType":"audio/flac"}
            ],"total":2,"limit":50,"offset":0}
        """.trimIndent()
        val resp = ApiHttp.json.decodeFromString(SearchResponse.serializer(), json)
        assertEquals(2, resp.files.size)
        assertEquals(2, resp.total)

        val f1 = resp.files[0]
        assertEquals("Taylor Swift", f1.artist)
        assertEquals("Love Story", f1.title)

        // Map sang Track: title rỗng → dùng name
        val t1 = MusicApiClient.Track(f1.id, f1.title.ifEmpty { f1.name }, f1.size, f1.mimeType, f1.artist)
        assertEquals("Love Story", t1.title)
        assertEquals("Taylor Swift", t1.artist)

        val f2 = resp.files[1]
        assertTrue(f2.artist.isEmpty())
        val t2 = MusicApiClient.Track(f2.id, f2.title.ifEmpty { f2.name }, f2.size, f2.mimeType, f2.artist)
        assertEquals("love me do", t2.title)
    }

    @Test
    fun parseSearchResponse_empty() {
        val resp = ApiHttp.json.decodeFromString(
            SearchResponse.serializer(),
            """{"files":[],"total":0,"limit":50,"offset":0}"""
        )
        assertTrue(resp.files.isEmpty())
        assertEquals(0, resp.total)
    }

    @Test
    fun parseSearchResponse_fallbackTotal() {
        // Fallback live Drive: total=-1 (không đếm được)
        val resp = ApiHttp.json.decodeFromString(
            SearchResponse.serializer(),
            """{"files":[],"total":-1,"limit":50,"offset":0}"""
        )
        assertEquals(-1, resp.total)
    }
}
