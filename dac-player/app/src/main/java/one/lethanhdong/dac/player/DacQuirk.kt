package one.lethanhdong.dac.player

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * DacQuirk — bảng quirks cho từng DAC (theo vendorId:productId).
 *
 * Spec P3 7.6: Room table theo `vendorId:productId`; hạt giống từ blocklist
 * UAPP (vendor 1478, 4184, 1133…).
 *
 * Đối chiếu:
 * - UAPP `lh4.c()`: blocklist vendor/product ID (thiết bị đã biết lỗi driver)
 * - Neutron: "Force 1ms packet" cho DAC buffer nhỏ / async USB sai
 * - HiBy: bus speed override (Auto/Full/High), force sample rate
 *
 * Các loại quirk:
 * - BLOCKLIST: DAC không tương thích, báo user (không cố kết nối)
 * - FORCE_1MS_PACKET: ép isochronous transfer 1ms (Neutron pattern)
 * - BUS_SPEED: ép USB bus speed (0=Auto, 1=Full, 2=High) (HiBy pattern)
 * - FORCE_SAMPLE_RATE: ép sample rate cố định (HiBy pattern)
 * - DISABLE_DSD: DAC báo có DSD nhưng thực tế lỗi → tắt DSD
 */
@Entity(tableName = "dac_quirks")
data class DacQuirk(
    @PrimaryKey
    val dacKey: String,  // "vid:pid" hex, vd "0x1234:0x5678"
    val quirkType: String, // BLOCKLIST, FORCE_1MS_PACKET, BUS_SPEED, FORCE_SAMPLE_RATE, DISABLE_DSD
    val value: String,   // giá trị quirk (vd "1" cho FORCE_1MS_PACKET, "44100" cho FORCE_SAMPLE_RATE)
    val reason: String,  // lý do (hiển thị cho user nếu cần)
    val userOverride: Boolean = false // true = user tự set, false = seed từ hãng
) {
    companion object {
        const val TYPE_BLOCKLIST = "BLOCKLIST"
        const val TYPE_FORCE_1MS = "FORCE_1MS_PACKET"
        const val TYPE_BUS_SPEED = "BUS_SPEED"
        const val TYPE_FORCE_RATE = "FORCE_SAMPLE_RATE"
        const val TYPE_DISABLE_DSD = "DISABLE_DSD"

        /** Tạo key từ vendorId/productId. */
        fun key(vendorId: Int, productId: Int): String =
            "0x${vendorId.toString(16)}:0x${productId.toString(16)}"
    }
}
