package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit test cho DsdToPcmConverter — verify logic DSD→PCM.
 *
 * Test bằng Python replicate trước khi push (VM không có JDK).
 */
class DsdToPcmConverterTest {

    @Test
    fun `pcmSampleRate - DSD64 ra 88200`() {
        assertEquals(88200, DsdToPcmConverter.pcmSampleRate(2822400))
    }

    @Test
    fun `pcmSampleRate - DSD128 ra 176400`() {
        assertEquals(176400, DsdToPcmConverter.pcmSampleRate(5644800))
    }

    @Test
    fun `convert - silence DSD ra PCM gần 0`() {
        // DSD silence: bit luân phiên 01010101... (DC = 0)
        // Dùng 128 bytes để filter ổn định (bỏ qua sample đầu)
        val dsd = ByteArray(128) { 0x55.toByte() } // 01010101
        val pcm = ByteArray(32 * 3) // 32 samples
        val written = DsdToPcmConverter.convert(dsd, 0, 128, pcm, 0)
        assertEquals(32 * 3, written)
        // Kiểm tra sample giữa (filter đã ổn định) phải gần 0
        val idx = 16 * 3
        val pcmVal = (pcm[idx].toInt() and 0xFF) or
                     ((pcm[idx + 1].toInt() and 0xFF) shl 8) or
                     ((pcm[idx + 2].toInt()) shl 16)
        assertTrue("PCM silence phải gần 0, gặp $pcmVal", Math.abs(pcmVal) < 100000)
    }

    @Test
    fun `convert - full scale DSD ra PCM lớn`() {
        // DSD full scale: toàn bit 1 (DC = +1.0)
        val dsd = ByteArray(128) { 0xFF.toByte() }
        val pcm = ByteArray(32 * 3)
        DsdToPcmConverter.convert(dsd, 0, 128, pcm, 0)
        val idx = 16 * 3
        val pcmVal = (pcm[idx].toInt() and 0xFF) or
                     ((pcm[idx + 1].toInt() and 0xFF) shl 8) or
                     ((pcm[idx + 2].toInt()) shl 16)
        assertTrue("PCM full scale phải lớn, gặp $pcmVal", pcmVal > 1000000)
    }

    @Test
    fun `convertStereo - output xen kẽ LRLR`() {
        // Dùng 128 bytes để filter ổn định
        val dsdL = ByteArray(128) { 0xFF.toByte() } // L full
        val dsdR = ByteArray(128) { 0x00.toByte() } // R silence (toàn 0 = -1.0)
        val pcm = ByteArray(32 * 6) // 32 samples stereo
        val written = DsdToPcmConverter.convertStereo(dsdL, 0, dsdR, 0, 128, pcm, 0)
        assertEquals(32 * 6, written)
        // Kiểm tra sample giữa
        val idx = 16 * 6
        val lVal = (pcm[idx].toInt() and 0xFF) or
                   ((pcm[idx + 1].toInt() and 0xFF) shl 8) or
                   ((pcm[idx + 2].toInt()) shl 16)
        val rVal = (pcm[idx + 3].toInt() and 0xFF) or
                   ((pcm[idx + 4].toInt() and 0xFF) shl 8) or
                   ((pcm[idx + 5].toInt()) shl 16)
        assertTrue("L phải dương lớn, gặp $lVal", lVal > 1000000)
        assertTrue("R phải âm, gặp $rVal", rVal < 0)
    }
}
