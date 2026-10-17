package one.lethanhdong.dac.player

import org.junit.Assert.*
import org.junit.Test

/**
 * Unit test cho DacSettings — verify key format và logic chọn extractor.
 * (Phần SharedPreferences cần Context nên test logic thuần ở đây.)
 */
class DacSettingsTest {

    @Test
    fun dacKey_format() {
        // vendorId=0x1234, productId=0x5678 → "0x1234:0x5678"
        // Key đầy đủ theo plan (kien-truc.md:185): "0x1234:0x5678|||DSDMethod"
        assertEquals("0x1234:0x5678", DacSettings.dacKey(0x1234, 0x5678))
    }

    @Test
    fun dsdMethodConstants() {
        assertEquals(0, DacSettings.DSD_METHOD_NATIVE)
        assertEquals(1, DacSettings.DSD_METHOD_DOP)
        assertEquals(2, DacSettings.DSD_METHOD_PCM)
        assertEquals(DacSettings.DSD_METHOD_DOP, DacSettings.DSD_METHOD_DEFAULT)
    }

    @Test
    fun shouldUseDsdExtractors_default() {
        // Mặc định là DoP → extractor DSD hoạt động
        // (currentDsdMethod khởi tạo = DSD_METHOD_DOP)
        assertTrue(DacSettings.shouldUseDsdExtractors())
    }
}
