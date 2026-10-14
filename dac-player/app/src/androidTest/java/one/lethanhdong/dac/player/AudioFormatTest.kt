package one.lethanhdong.dac.player

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.4: test badge chất lượng nguồn → DAC.
 * Logic thuần — không cần DAC thật, không cần mạng.
 */
@RunWith(AndroidJUnit4::class)
class AudioFormatTest {

    @Test
    fun formatLabel_cases() {
        assertEquals("FLAC", AudioFormat.formatLabel("audio/flac", "bai.flac"))
        assertEquals("FLAC", AudioFormat.formatLabel("", "Bai Hat.FLAC"))
        assertEquals("WAV", AudioFormat.formatLabel("audio/wav", "x.wav"))
        assertEquals("MP3", AudioFormat.formatLabel("audio/mpeg", "x.mp3"))
        assertEquals("M4A", AudioFormat.formatLabel("audio/mp4", "x.m4a"))
        assertEquals("OGG", AudioFormat.formatLabel("audio/ogg", "x.ogg"))
        assertEquals("AUDIO", AudioFormat.formatLabel("", "khong-duoi"))
        assertEquals("AUDIO", AudioFormat.formatLabel("application/octet-stream", "x.bin"))
    }

    @Test
    fun formatSampleRate_cases() {
        assertEquals("96 kHz", AudioFormat.formatSampleRate(96000))
        assertEquals("44.1 kHz", AudioFormat.formatSampleRate(44100))
        assertEquals("48 kHz", AudioFormat.formatSampleRate(48000))
        assertEquals("192 kHz", AudioFormat.formatSampleRate(192000))
        assertEquals("88.2 kHz", AudioFormat.formatSampleRate(88200))
    }

    @Test
    fun badgeText_full() {
        assertEquals(
            "FLAC • 24-bit • 96 kHz → USB DAC",
            AudioFormat.badgeText("FLAC", 24, 96000, viaUsbDac = true),
        )
    }

    @Test
    fun badgeText_missingFields_notFabricated() {
        // Không đo được bit depth → bỏ qua, không bịa
        assertEquals(
            "MP3 • 44.1 kHz",
            AudioFormat.badgeText("MP3", null, 44100, viaUsbDac = false),
        )
        // Không đo được gì → chỉ còn định dạng
        assertEquals(
            "AUDIO",
            AudioFormat.badgeText("AUDIO", null, null, viaUsbDac = false),
        )
        // sampleRate 0/invalid → bỏ qua
        assertEquals(
            "WAV",
            AudioFormat.badgeText("WAV", null, 0, viaUsbDac = false),
        )
    }

    @Test
    fun playerManager_badgeText_delegates() {
        val q = PlayerManager.AudioQuality(
            sampleRateHz = 96000,
            bitDepth = 24,
            formatLabel = "FLAC",
            viaUsbDac = true,
        )
        assertEquals("FLAC • 24-bit • 96 kHz → USB DAC", q.badgeText())
    }
}
