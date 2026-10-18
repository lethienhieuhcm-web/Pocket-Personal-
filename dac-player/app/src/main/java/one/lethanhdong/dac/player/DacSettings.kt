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
 * - 2 = PCM (DSD→PCM fallback — convert bằng software trong extractor, đã xong 17/10)
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
     * Buffer (số URB) — global, không per-DAC vì là thuộc tính pipeline.
     * 80 ≈ 80ms @44.1kHz (mặc định), 200 ≈ 200ms, 400 ≈ 400ms.
     */
    fun getBufferUrbs(context: Context): Int {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getInt("buffer_urbs", 80).coerceIn(16, 400)
    }

    fun setBufferUrbs(context: Context, urbs: Int) {
        require(urbs in 16..400) { "Số URB không hợp lệ: $urbs" }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt("buffer_urbs", urbs)
            .apply()
    }

    /**
     * Gapless — global, không per-DAC.
     * Mặc định bật (theo HiBy "seamless").
     * Tắt → force stop/start giữa các bài (có gap).
     */
    fun isGaplessEnabled(context: Context): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getBoolean("gapless_enabled", true)
    }

    fun setGaplessEnabled(context: Context, enabled: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean("gapless_enabled", enabled)
            .apply()
    }

    /**
     * Key SharedPreferences cho hardware volume — per-DAC như DSD method.
     * Giá trị 0–100, mặc định 100 (tối đa = bit-perfect).
     */
    private fun volumeKey(vendorId: Int, productId: Int): String =
        "${dacKey(vendorId, productId)}|||Volume"

    /** Đọc hardware volume đã lưu cho DAC (0–100, mặc định 100). */
    fun getVolume(context: Context, vendorId: Int, productId: Int): Int {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return prefs.getInt(volumeKey(vendorId, productId), 100).coerceIn(0, 100)
    }

    /** Lưu hardware volume cho DAC. */
    fun setVolume(context: Context, vendorId: Int, productId: Int, volume: Int) {
        require(volume in 0..100) { "Volume không hợp lệ: $volume" }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putInt(volumeKey(vendorId, productId), volume)
            .apply()
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

    /**
     * Extractor DSD có nên nhận file không? True cho cả 3 mode:
     * DoP (output DoP), Native (sau này), PCM (output PCM fallback).
     * @deprecated Dùng currentDsdMethod trực tiếp trong extractor.
     */
    @Deprecated("Dùng currentDsdMethod trực tiếp")
    fun shouldUseDsdExtractors(): Boolean =
        currentDsdMethod == DSD_METHOD_DOP ||
        currentDsdMethod == DSD_METHOD_NATIVE ||
        currentDsdMethod == DSD_METHOD_PCM
}
