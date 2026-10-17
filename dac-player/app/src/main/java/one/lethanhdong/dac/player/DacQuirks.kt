package one.lethanhdong.dac.player

import android.content.Context
import android.content.SharedPreferences

/**
 * DacQuirks — quirks cho từng DAC, hardcode + user override.
 *
 * Spec P3 7.6 (sửa 2026-10-17): KHÔNG dùng Room.
 * - Hardcode Kotlin object theo `vendorId:productId` (như UAPP `lh4.c()`)
 * - User override qua SharedPreferences (như Neutron `USBForce1MsPacket`,
 *   HiBy `UsbSpeedSettingActivity`)
 * - Lý do: quirks check ở USB hot path cần đồng bộ ngay, không chờ coroutine.
 *
 * Các loại quirk:
 * - BLOCKLIST: DAC không tương thích (UAPP: vendor 1478, 4184, 1133)
 * - FORCE_1MS_PACKET: ép isochronous 1ms (Neutron: DAC buffer nhỏ)
 * - BUS_SPEED: 0=Auto, 1=Full, 2=High (HiBy: DAC kén bus speed)
 * - FORCE_SAMPLE_RATE: ép sample rate (HiBy: DAC báo sai)
 * - DISABLE_DSD: tắt DSD (DAC báo có nhưng lỗi)
 */
object DacQuirks {

    const val BLOCKLIST = "blocklist"
    const val FORCE_1MS_PACKET = "force_1ms"
    const val BUS_SPEED = "bus_speed"
    const val FORCE_SAMPLE_RATE = "force_rate"
    const val DISABLE_DSD = "disable_dsd"

    /** Quirk hardcode: key "vid:pid" hex → map quirk → giá trị. */
    private val HARDCODED: Map<String, Map<String, String>> = mapOf(
        // UAPP blocklist: vendor đã biết lỗi driver (áp dụng mọi product)
        key(1478, 0xFFFF) to mapOf(BLOCKLIST to "1"),
        key(4184, 0xFFFF) to mapOf(BLOCKLIST to "1"),
        key(1133, 0xFFFF) to mapOf(BLOCKLIST to "1"),
    )

    /** Tạo key từ vendorId/productId. */
    fun key(vendorId: Int, productId: Int): String =
        "0x${vendorId.toString(16)}:0x${productId.toString(16)}"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences("dac_quirks", Context.MODE_PRIVATE)

    /**
     * Lấy quirk cho DAC. Ưu tiên: user override → hardcode exact → hardcode wildcard.
     * Đồng bộ — gọi được từ USB hot path.
     */
    fun getQuirk(context: Context, vendorId: Int, productId: Int, type: String): String? {
        // 1. User override
        prefs(context).getString("${key(vendorId, productId)}:$type", null)?.let { return it }
        // 2. Hardcode exact match
        HARDCODED[key(vendorId, productId)]?.get(type)?.let { return it }
        // 3. Hardcode wildcard vendor
        return HARDCODED[key(vendorId, 0xFFFF)]?.get(type)
    }

    /** Kiểm tra DAC có bị blocklist không. Đồng bộ. */
    fun isBlocklisted(context: Context, vendorId: Int, productId: Int): Boolean =
        getQuirk(context, vendorId, productId, BLOCKLIST) == "1"

    /** User tự set override. Đồng bộ. */
    fun setUserOverride(context: Context, vendorId: Int, productId: Int, type: String, value: String) {
        prefs(context).edit()
            .putString("${key(vendorId, productId)}:$type", value)
            .apply()
    }

    /** Xóa override của user, về giá trị hardcode. Đồng bộ. */
    fun clearUserOverride(context: Context, vendorId: Int, productId: Int, type: String) {
        prefs(context).edit()
            .remove("${key(vendorId, productId)}:$type")
            .apply()
    }
}
