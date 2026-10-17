package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit test cho DacQuirks — phần logic thuần (không cần Context).
 * Phần SharedPreferences test trên emulator/device thật.
 */
class DacQuirksTest {

    @Test
    fun `key - tạo đúng format hex`() {
        assertEquals("0x1234:0x5678", DacQuirks.key(0x1234, 0x5678))
    }

    @Test
    fun `key - vendor UAPP blocklist`() {
        assertEquals("0x5c6:0xffff", DacQuirks.key(1478, 0xFFFF))
    }

    @Test
    fun `constants - đủ 5 loại quirk`() {
        assertEquals("blocklist", DacQuirks.BLOCKLIST)
        assertEquals("force_1ms", DacQuirks.FORCE_1MS_PACKET)
        assertEquals("bus_speed", DacQuirks.BUS_SPEED)
        assertEquals("force_rate", DacQuirks.FORCE_SAMPLE_RATE)
        assertEquals("disable_dsd", DacQuirks.DISABLE_DSD)
    }
}
