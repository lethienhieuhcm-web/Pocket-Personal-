package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit test cho DacQuirk — verify key generation và quirk types.
 * Logic đã verify bằng Python replicate.
 */
class DacQuirkTest {

    @Test
    fun `key - tạo đúng format hex`() {
        assertEquals("0x1234:0x5678", DacQuirk.key(0x1234, 0x5678))
    }

    @Test
    fun `key - vendor UAPP blocklist`() {
        // vendor 1478 = 0x5C6
        assertEquals("0x5c6:0xffff", DacQuirk.key(1478, 0xFFFF))
    }

    @Test
    fun `quirk types - đủ 5 loại`() {
        assertEquals("BLOCKLIST", DacQuirk.TYPE_BLOCKLIST)
        assertEquals("FORCE_1MS_PACKET", DacQuirk.TYPE_FORCE_1MS)
        assertEquals("BUS_SPEED", DacQuirk.TYPE_BUS_SPEED)
        assertEquals("FORCE_SAMPLE_RATE", DacQuirk.TYPE_FORCE_RATE)
        assertEquals("DISABLE_DSD", DacQuirk.TYPE_DISABLE_DSD)
    }

    @Test
    fun `DacQuirk - userOverride mặc định false`() {
        val q = DacQuirk("0x1:0x2", DacQuirk.TYPE_BLOCKLIST, "1", "test")
        assertFalse(q.userOverride)
    }
}
