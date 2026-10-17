package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit test cho DopPacker — verify bit-level theo chuẩn DoP v1.1.
 * Logic đã verify bằng Python replicate (5/5 PASS ngày 2026-10-17).
 */
class DopPackerTest {

    @Test
    fun reverseBits_correct() {
        assertEquals(0x80.toByte(), DopPacker.reverseBits(0x01))
        assertEquals(0x55.toByte(), DopPacker.reverseBits(0xAA.toByte()))
        assertEquals(0xFF.toByte(), DopPacker.reverseBits(0xFF.toByte()))
        assertEquals(0x00.toByte(), DopPacker.reverseBits(0x00))
    }

    @Test
    fun packStereoFrame_markersAlternate() {
        val out = ByteArray(6)
        DopPacker.packStereoFrame(
            byteArrayOf(0x69, 0x96.toByte()),
            byteArrayOf(0xA5.toByte(), 0x5A),
            DopPacker.MARKER_A,
            out, 0
        )
        // Marker luân phiên 0x05 / 0xFA
        assertEquals(DopPacker.MARKER_A, out[2])
        assertEquals(DopPacker.MARKER_B, out[5])
        // DSD đã đảo bit
        assertEquals(DopPacker.reverseBits(0x69), out[0])
        assertEquals(DopPacker.reverseBits(0xA5.toByte()), out[3])
    }

    @Test
    fun dopSampleRate_dsd64() {
        assertEquals(176400, DopPacker.dopSampleRate(2822400))
    }

    @Test
    fun dopSampleRate_dsd128() {
        assertEquals(352800, DopPacker.dopSampleRate(5644800))
    }

    @Test
    fun isValidDopStream_detectsCorruption() {
        val out = ByteArray(12)
        DopPacker.packStereoFrame(
            byteArrayOf(0x11, 0x22), byteArrayOf(0x33, 0x44),
            DopPacker.MARKER_A, out, 0
        )
        DopPacker.packStereoFrame(
            byteArrayOf(0x55, 0x66), byteArrayOf(0x77, 0x88.toByte()),
            DopPacker.MARKER_A, out, 6
        )
        assertTrue(DopPacker.isValidDopStream(out))

        // Phá 1 marker → phải phát hiện
        out[5] = DopPacker.MARKER_A // đáng lẽ là MARKER_B
        assertFalse(DopPacker.isValidDopStream(out))
    }
}
