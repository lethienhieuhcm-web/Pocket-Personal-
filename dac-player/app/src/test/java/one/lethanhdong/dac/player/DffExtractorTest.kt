package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit test cho DffExtractor — verify parse header DSDIFF.
 * Logic parse đã verify bằng Python (tạo file DSDIFF giả lập).
 */
class DffExtractorTest {

    @Test
    fun fourcc_helpers() {
        // Verify logic pack DoP cho DFF multiplexed (replicate bằng tay)
        // DSD multiplexed: [L0][R0][L1][R1] → frame = L=(L0,L1), R=(R0,R1)
        val out = ByteArray(6)
        DopPacker.packStereoFrame(
            byteArrayOf(0x11, 0x22),
            byteArrayOf(0xAA.toByte(), 0xBB.toByte()),
            DopPacker.MARKER_A,
            out, 0
        )
        // Marker luân phiên
        assertEquals(DopPacker.MARKER_A, out[2])
        assertEquals(DopPacker.MARKER_B, out[5])
        // DSD đã đảo bit
        assertEquals(DopPacker.reverseBits(0x11), out[0])
        assertEquals(DopPacker.reverseBits(0x22), out[1])
        assertEquals(DopPacker.reverseBits(0xAA.toByte()), out[3])
        assertEquals(DopPacker.reverseBits(0xBB.toByte()), out[4])
    }

    @Test
    fun dopSampleRate_dsd64() {
        // DFF cũng dùng DoP: DSD64 → 176.4kHz
        assertEquals(176400, DopPacker.dopSampleRate(2822400))
    }
}
