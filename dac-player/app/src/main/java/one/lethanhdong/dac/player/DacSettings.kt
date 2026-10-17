package one.lethanhdong.dac.player

import android.content.Context

/**
 * DacSettings — cài đặt riêng cho từng DAC (per-DAC settings).
 *
 * Key: "vendorId:productId" (hex, vd "0x1234:0x5678") — theo spec P3.
 * Lưu bằng SharedPreferences "dac_settings" (không cần mã hoá, không phải secret).
 *
 * Spec P3 dòng 23: DSD ưu tiên Native → DoP → PCM, chọn trong setting per-DAC.
 * - 0 = Native (DSD native — Phase 5, chưa implement)
 * - 1 = DoP (mặc định — Phase 1 đã xong)
 * - 2 = PCM (DSD→PCM fallback — cần FFmpeg, chưa xong)
 *
 * Vì extractor của Media3 không có Context, PlayerManager sẽ đọc setting
 * khi DAC thay đổi và cập nhật vào [currentDsdMethod] (static) để extractor
 * check trong sniff().
 */
object DacSettings {

    const val DSD_METHOD_NATIVE = 0
    const val DSD_METHOD_DOP = 1
    const val DSD_METHOD_PCM = 2

    /** Mặc định: DoP (lựa chọn duy nhất hoạt động ở hiện tại). */
    const val DSD_METHOD_DEFAULT = DSD_METHOD_DOP

    private const val PREFS = "dac_settings"

    /**
     * DSD method hiện tại (static, để extractor không cần Context).
     * PlayerManager cập nhật khi DAC kết nối/thay đổi hoặc user đổi setting.
     */
    @Volatile
    var currentDsdMethod: Int = DSD_METHOD_DEFAULT
        private set

    /** Key DAC từ vendorId/productId: "0x1234:0x5678". */
    fun dacKey(vendorId: Int, productId: Int): String =
        "0x${vendorId.toString(16)}:0x${productId.toString(16)}"

    /**
     * Key SharedPreferences cho DSD method — đúng format plan (kien-truc.md dòng 185):
     * prefs["$dacId|||DSDMethod"] = 0  // 0=Native, 1=DoP, 2=PCM
     */
    private fun dsdMethodKey(vendorId: Int, productId: Int): String =
        "${dacKey(vendorId, productId)}|||DSDMethod"

    /** Đọc DSD method đã lưu cho DAC, null nếu chưa có. */
    fun getDsdMethod(context: Context, vendorId: Int, productId: Int): Int {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getInt(dsdMethodKey(vendorId, productId), DSD_METHOD_DEFAULT)
    }

    /** Lưu DSD method cho DAC. */
    fun setDsdMethod(context: Context, vendorId: Int, productId: Int, method: Int) {
        require(method in DSD_METHOD_NATIVE..DSD_METHOD_PCM) {
            "DSD method không hợp lệ: $method"
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt(dsdMethodKey(vendorId, productId), method)
            .apply()
        // Cập nhật static nếu đang là DAC hiện tại
        currentDsdMethod = method
    }

    /**
     * Cập nhật [currentDsdMethod] từ DAC đang cắm.
     * Gọi khi app khởi động, khi DAC kết nối/thay đổi.
     * Nếu không có DAC: giữ nguyên giá trị hiện tại.
     */
    fun refreshFromConnectedDac(context: Context) {
        val device = try {
            com.decent.usbaudio.UsbAudioDevice.getInstance(context).findUsbAudioDevice()
        } catch (_: Exception) {
            null
        }
        if (device != null) {
            currentDsdMethod = getDsdMethod(context, device.vendorId, device.productId)
        }
    }

    /** Extractor DSD có nên nhận file không? Chỉ khi method là DoP (hoặc Native sau này). */
    fun shouldUseDsdExtractors(): Boolean =
        currentDsdMethod == DSD_METHOD_DOP || currentDsdMethod == DSD_METHOD_NATIVE
}
