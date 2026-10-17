package one.lethanhdong.dac.player

import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * QuirkManager — quản lý quirks cho từng DAC.
 *
 * Spec P3 7.6: hạt giống từ blocklist UAPP (vendor 1478, 4184, 1133…).
 *
 * UAPP `lh4.c()` blocklist (từ phân tích uapp.md):
 * - vendor 1478, 4184, 1133: thiết bị đã biết lỗi driver → BLOCKLIST
 *
 * Neutron pattern: FORCE_1MS_PACKET cho DAC buffer nhỏ.
 * HiBy pattern: BUS_SPEED override, FORCE_SAMPLE_RATE.
 */
object QuirkManager {

    /**
     * Seed data từ blocklist UAPP + patterns Neutron/HiBy.
     * Chạy 1 lần khi app khởi động (nếu bảng trống).
     */
    private fun seedQuirks(): List<DacQuirk> = listOf(
        // UAPP blocklist — vendor đã biết lỗi driver
        // (productId 0xFFFF = áp dụng cho mọi product của vendor này)
        DacQuirk(
            dacKey = DacQuirk.key(1478, 0xFFFF),
            quirkType = DacQuirk.TYPE_BLOCKLIST,
            value = "1",
            reason = "UAPP blocklist: vendor đã biết lỗi driver USB"
        ),
        DacQuirk(
            dacKey = DacQuirk.key(4184, 0xFFFF),
            quirkType = DacQuirk.TYPE_BLOCKLIST,
            value = "1",
            reason = "UAPP blocklist: vendor đã biết lỗi driver USB"
        ),
        DacQuirk(
            dacKey = DacQuirk.key(1133, 0xFFFF),
            quirkType = DacQuirk.TYPE_BLOCKLIST,
            value = "1",
            reason = "UAPP blocklist: vendor đã biết lỗi driver USB"
        )
    )

    /**
     * Khởi tạo: seed quirks nếu bảng trống.
     * Gọi từ Application.onCreate (background thread).
     */
    fun init(context: Context) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val db = MusicDatabase.getInstance(context)
                if (db.dacQuirkDao().count() == 0) {
                    db.dacQuirkDao().insertAll(seedQuirks())
                }
            } catch (_: Exception) {
                // Database chưa migrate xong — bỏ qua, lần sau thử lại
            }
        }
    }

    /**
     * Kiểm tra DAC có bị blocklist không.
     * Check cả key chính xác và wildcard vendor (pid=0xFFFF).
     */
    suspend fun isBlocklisted(context: Context, vendorId: Int, productId: Int): Boolean {
        val db = MusicDatabase.getInstance(context)
        val exact = db.dacQuirkDao().getQuirk(
            DacQuirk.key(vendorId, productId), DacQuirk.TYPE_BLOCKLIST
        )
        if (exact != null) return true
        val wildcard = db.dacQuirkDao().getQuirk(
            DacQuirk.key(vendorId, 0xFFFF), DacQuirk.TYPE_BLOCKLIST
        )
        return wildcard != null
    }

    /**
     * Lấy quirk cho DAC (ưu tiên key chính xác, fallback wildcard vendor).
     */
    suspend fun getQuirk(
        context: Context, vendorId: Int, productId: Int, type: String
    ): DacQuirk? {
        val db = MusicDatabase.getInstance(context)
        return db.dacQuirkDao().getQuirk(DacQuirk.key(vendorId, productId), type)
            ?: db.dacQuirkDao().getQuirk(DacQuirk.key(vendorId, 0xFFFF), type)
    }

    /**
     * User tự set quirk override (vd: ép 1ms packet khi DAC bị giật).
     */
    suspend fun setUserQuirk(
        context: Context, vendorId: Int, productId: Int,
        type: String, value: String, reason: String
    ) {
        val db = MusicDatabase.getInstance(context)
        db.dacQuirkDao().insert(
            DacQuirk(
                dacKey = DacQuirk.key(vendorId, productId),
                quirkType = type,
                value = value,
                reason = reason,
                userOverride = true
            )
        )
    }
}
