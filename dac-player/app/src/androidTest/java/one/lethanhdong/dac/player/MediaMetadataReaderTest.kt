package one.lethanhdong.dac.player

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream

/**
 * Test MediaMetadataReader — plan dac-app 1.4.
 * Dùng 2 file FLAC thật (tạo bằng ffmpeg, ở androidTest/assets):
 * - test_with_art.flac: 1s sine + ảnh PNG đỏ nhúng (attached_pic) + metadata
 * - test_no_art.flac: 1s sine, không ảnh, có metadata
 * Chạy trên emulator CI (MediaMetadataRetriever là Android SDK).
 */
@RunWith(AndroidJUnit4::class)
class MediaMetadataReaderTest {

    private fun copyAssetToFile(name: String): File {
        val ctx: Context = InstrumentationRegistry.getInstrumentation().targetContext
        val out = File(ctx.cacheDir, name)
        ctx.assets.open(name).use { input ->
            FileOutputStream(out).use { output -> input.copyTo(output) }
        }
        return out
    }

    @Test
    fun embeddedArt_fileWithArt_returnsPngBytes() = runBlocking {
        val file = copyAssetToFile("test_with_art.flac")
        val art = MediaMetadataReader.embeddedArtFromPath(file.absolutePath)
        assertNotNull("File có ảnh nhúng phải trả bytes", art)
        // PNG header: 89 50 4E 47 0D 0A 1A 0A
        assertArrayEquals(
            byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A),
            art!!.copyOf(8)
        )
        assertEquals("image/png", CoverArt.guessMime(art))
    }

    @Test
    fun embeddedArt_fileWithoutArt_returnsNull() = runBlocking {
        val file = copyAssetToFile("test_no_art.flac")
        assertNull(MediaMetadataReader.embeddedArtFromPath(file.absolutePath))
    }

    @Test
    fun metadata_readsTitleArtistAlbumDuration() = runBlocking {
        val file = copyAssetToFile("test_with_art.flac")
        val meta = MediaMetadataReader.readFromPath(file.absolutePath)
        assertNotNull(meta)
        assertEquals("Test Song", meta!!.title)
        assertEquals("Test Artist", meta.artist)
        assertEquals("Test Album", meta.album)
        // 1s sine → duration ~1000ms (cho phép sai số nhỏ do encoder)
        val duration = meta.durationMs ?: -1
        assertEquals(true, duration in 900..1100)
    }

    @Test
    fun guessMime_jpeg_returnsJpeg() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())
        assertEquals("image/jpeg", CoverArt.guessMime(jpeg))
    }

    @Test
    fun guessMime_unknown_returnsNull() {
        assertNull(CoverArt.guessMime(byteArrayOf(1, 2, 3, 4)))
        assertNull(CoverArt.guessMime(byteArrayOf()))
    }
}
