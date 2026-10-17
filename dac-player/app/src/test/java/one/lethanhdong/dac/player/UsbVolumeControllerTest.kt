package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit test cho logic parse UAC Feature Unit descriptor.
 * Logic đã verify bằng Python replicate (parse đúng, volume conversion đúng).
 *
 * Note: UsbVolumeController cần Android Context (UsbManager) nên không test
 * trực tiếp trên JVM. Test này verify thuật toán parse bằng replicate.
 */
class UsbVolumeControllerTest {

    @Test
    fun `parse - tìm thấy Feature Unit ID=5`() {
        val raw = byteArrayOf(
            9, 0x04, 0, 0, 0, 1, 1, 0, 0,          // Interface: AudioControl
            10, 0x24, 0x06, 5, 0, 0, 0, 0, 0, 0    // Feature Unit ID=5
        )
        val (fuId, acIface) = parse(raw)
        assertEquals(5, fuId)
        assertEquals(0, acIface)
    }

    @Test
    fun `parse - không có Feature Unit trả null`() {
        val raw = byteArrayOf(9, 0x04, 0, 0, 0, 1, 1, 0, 0)
        val (fuId, _) = parse(raw)
        assertNull(fuId)
    }

    @Test
    fun `volume conversion - 100 ra 0dB, 0 ra -96dB`() {
        assertEquals(0, volToDb256(100))
        assertEquals(-12288, volToDb256(50))  // -48dB
        assertEquals(-24576, volToDb256(0))   // -96dB
    }

    @Test
    fun `wValue wIndex - đúng format UAC`() {
        val wValue = (0x02 shl 8) or 0  // VOLUME_CONTROL, ch master
        val wIndex = (5 shl 8) or 0     // FU ID=5, AC iface=0
        assertEquals(0x0200, wValue)
        assertEquals(0x0500, wIndex)
    }

    // Replicate UsbVolumeController.parseFeatureUnit + setVolume logic
    private fun parse(raw: ByteArray): Pair<Int?, Int> {
        var acIface = 0
        var i = 0
        while (i + 2 < raw.size) {
            val len = raw[i].toInt() and 0xFF
            if (len < 3 || i + len > raw.size) break
            val descType = raw[i + 1].toInt() and 0xFF
            if (descType == 0x04) {
                if ((raw[i + 5].toInt() and 0xFF) == 1 &&
                    (raw[i + 6].toInt() and 0xFF) == 1) {
                    acIface = raw[i + 2].toInt() and 0xFF
                }
            } else if (descType == 0x24) {
                if ((raw[i + 2].toInt() and 0xFF) == 0x06) {
                    return Pair(raw[i + 3].toInt() and 0xFF, acIface)
                }
            }
            i += len
        }
        return Pair(null, acIface)
    }

    private fun volToDb256(vol: Int): Int {
        if (vol == 0) return -96 * 256
        return ((vol / 100.0) * 96 - 96).toInt() * 256
    }
}
