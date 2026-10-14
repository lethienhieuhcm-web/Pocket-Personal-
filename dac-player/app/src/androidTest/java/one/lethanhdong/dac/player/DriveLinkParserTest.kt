package one.lethanhdong.dac.player

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Unit test cho DriveLinkParser — plan dac-app 2.1.
 * Chạy trên emulator (androidTest) cùng các test khác.
 */
@RunWith(AndroidJUnit4::class)
class DriveLinkParserTest {

    // ID mẫu 33 ký tự (độ dài thật của Drive ID)
    private val sampleId = "1aB2cD3eF4gH5iJ6kL7mN8oP9qR0sT1u"

    @Test
    fun parse_fileLink() {
        val id = DriveLinkParser.parse(
            "https://drive.google.com/file/d/$sampleId/view?usp=sharing"
        )
        assertEquals(sampleId, id)
    }

    @Test
    fun parse_folderLink() {
        val id = DriveLinkParser.parse(
            "https://drive.google.com/drive/folders/$sampleId?usp=sharing"
        )
        assertEquals(sampleId, id)
    }

    @Test
    fun parse_openLink() {
        val id = DriveLinkParser.parse(
            "https://drive.google.com/open?id=$sampleId"
        )
        assertEquals(sampleId, id)
    }

    @Test
    fun parse_docsLink() {
        val id = DriveLinkParser.parse(
            "https://docs.google.com/document/d/${sampleId}/edit"
        )
        assertEquals(sampleId, id)
    }

    @Test
    fun parse_bareId() {
        assertEquals(sampleId, DriveLinkParser.parse(sampleId))
        assertEquals(sampleId, DriveLinkParser.parse("  $sampleId  "))
    }

    @Test
    fun parse_invalid() {
        assertNull(DriveLinkParser.parse(null))
        assertNull(DriveLinkParser.parse(""))
        assertNull(DriveLinkParser.parse("   "))
        assertNull(DriveLinkParser.parse("https://example.com/not-a-drive-link"))
        assertNull(DriveLinkParser.parse("abc")) // quá ngắn, không phải ID
    }

    @Test
    fun looksValid() {
        assertTrue(DriveLinkParser.looksValid("https://drive.google.com/file/d/$sampleId/view"))
        assertFalse(DriveLinkParser.looksValid("hello"))
        assertFalse(DriveLinkParser.looksValid(null))
    }
}
