package one.lethanhdong.dac.player

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 2.3: Test cho TagReader.isSupported() (pure logic, không cần file thật).
 */
@RunWith(AndroidJUnit4::class)
class TagReaderTest {

    @Test
    fun isSupported_audioExtensions() {
        assertTrue(TagReader.isSupported("song.mp3"))
        assertTrue(TagReader.isSupported("song.flac"))
        assertTrue(TagReader.isSupported("song.wav"))
        assertTrue(TagReader.isSupported("song.m4a"))
        assertTrue(TagReader.isSupported("song.ogg"))
        assertTrue(TagReader.isSupported("song.opus"))
        // Case-insensitive
        assertTrue(TagReader.isSupported("SONG.MP3"))
        assertTrue(TagReader.isSupported("song.FLAC"))
    }

    @Test
    fun isSupported_nonAudio() {
        assertFalse(TagReader.isSupported("document.pdf"))
        assertFalse(TagReader.isSupported("video.mp4"))
        assertFalse(TagReader.isSupported("image.jpg"))
        assertFalse(TagReader.isSupported("noextension"))
        assertFalse(TagReader.isSupported(""))
    }
}
