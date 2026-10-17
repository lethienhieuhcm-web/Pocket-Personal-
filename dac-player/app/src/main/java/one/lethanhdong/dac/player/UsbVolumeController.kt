package one.lethanhdong.dac.player

import android.content.Context
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import com.decent.usbaudio.UsbAudioDevice

/**
 * UsbVolumeController — điều khiển volume phần cứng của DAC qua UAC Feature Unit.
 *
 * Spec P3 7.5: App-level, UAC feature-unit `SET_CUR` qua USB control transfer.
 * DAC không có feature-unit → software volume + báo rõ.
 *
 * Đối chiếu:
 * - decent-player lib: KHÔNG có volume control (chỉ SET_CUR cho sample rate)
 * - UAPP: `USBMixerUnit`/`USBMixerUnitVolumeController` — parse descriptor riêng
 * - HiBy: khóa volume USB để giữ bit-perfect
 *
 * UAC Volume Control (USB Audio Class spec):
 * - bmRequestType = 0x21 (Host→Device, Class, Interface)
 * - bRequest = 0x01 (SET_CUR)
 * - wValue = (0x02 << 8) | channel — 0x02 = VOLUME_CONTROL, ch 0 = master
 * - wIndex = (featureUnitId << 8) | audioControlInterface
 * - Data = 2 bytes LE, signed 16-bit, đơn vị 1/256 dB
 *
 * Mở connection riêng cho control transfer (endpoint 0) — không tranh chấp
 * với isochronous streaming của lib (dùng endpoint audio riêng).
 */
class UsbVolumeController(private val context: Context) {

    companion object {
        // USB descriptor types
        private const val USB_DT_INTERFACE = 0x04
        // UAC constants
        private const val CS_INTERFACE = 0x24
        private const val FEATURE_UNIT = 0x06
        private const val VOLUME_CONTROL = 0x02

        // USB request
        private const val REQ_TYPE_CLASS_INTERFACE_OUT = 0x21
        private const val REQ_SET_CUR = 0x01

        /** Volume range UAC: -96dB đến 0dB (đơn vị 1/256 dB). */
        const val VOLUME_MIN_DB256 = -96 * 256
        const val VOLUME_MAX_DB256 = 0
    }

    private val usbManager: UsbManager? =
        context.getSystemService(Context.USB_SERVICE) as? UsbManager

    /** Feature Unit ID của DAC, null nếu không tìm thấy (dùng software volume). */
    var featureUnitId: Int? = null
        private set

    /** AudioControl interface number. */
    private var audioControlIface: Int = 0

    /** True nếu DAC có hardware volume (tìm thấy Feature Unit). */
    val hasHardwareVolume: Boolean get() = featureUnitId != null

    /**
     * Khởi tạo: tìm DAC, parse descriptor để lấy Feature Unit ID.
     * Gọi 1 lần khi DAC kết nối.
     * @return true nếu tìm thấy hardware volume
     */
    fun init(): Boolean {
        val device = UsbAudioDevice.getInstance(context).findUsbAudioDevice()
            ?: return false
        return init(device)
    }

    fun init(device: UsbDevice): Boolean {
        val mgr = usbManager ?: return false
        var conn: UsbDeviceConnection? = null
        try {
            conn = mgr.openDevice(device) ?: return false
            val raw = conn.rawDescriptors ?: return false
            val (fuId, acIface) = parseFeatureUnit(raw)
            featureUnitId = fuId
            if (fuId != null) audioControlIface = acIface
            return fuId != null
        } catch (_: Exception) {
            return false
        } finally {
            try { conn?.close() } catch (_: Exception) {}
        }
    }

    /**
     * Parse raw USB descriptors tìm Feature Unit (UAC).
     * @return Pair(featureUnitId?, audioControlInterface)
     */
    fun parseFeatureUnit(raw: ByteArray): Pair<Int?, Int> {
        var acIface = 0
        var i = 0
        // Tìm AudioControl interface trước (class=1, subclass=1)
        // rồi quét CS_INTERFACE subtype FEATURE_UNIT (0x06)
        while (i + 2 < raw.size) {
            val len = raw[i].toInt() and 0xFF
            if (len < 3 || i + len > raw.size) break
            val descType = raw[i + 1].toInt() and 0xFF

            if (descType == USB_DT_INTERFACE) {
                val ifaceClass = raw[i + 5].toInt() and 0xFF
                val ifaceSubclass = raw[i + 6].toInt() and 0xFF
                if (ifaceClass == 1 && ifaceSubclass == 1) {
                    acIface = raw[i + 2].toInt() and 0xFF
                }
            } else if (descType == CS_INTERFACE) {
                val subtype = raw[i + 2].toInt() and 0xFF
                if (subtype == FEATURE_UNIT) {
                    // Byte 3 = bUnitID của Feature Unit
                    val unitId = raw[i + 3].toInt() and 0xFF
                    return Pair(unitId, acIface)
                }
            }
            i += len
        }
        return Pair(null, acIface)
    }

    /**
     * Set hardware volume (0-100) → chuyển thành dB rồi gửi SET_CUR.
     * @param volume 0..100
     * @return true nếu gửi thành công
     */
    fun setVolume(volume: Int): Boolean {
        val fuId = featureUnitId ?: return false
        val vol = volume.coerceIn(0, 100)
        // Chuyển 0-100 → dB (log scale cho tự nhiên):
        // 0 → -96dB (mute gần), 100 → 0dB
        val db256 = if (vol == 0) VOLUME_MIN_DB256
                    else ((vol / 100.0) * 96 - 96).toInt() * 256
        return setVolumeDb256(db256, fuId)
    }

    /**
     * Set volume trực tiếp bằng đơn vị 1/256 dB.
     */
    fun setVolumeDb256(db256: Int, fuId: Int? = null): Boolean {
        val fid = fuId ?: featureUnitId ?: return false
        val device = UsbAudioDevice.getInstance(context).findUsbAudioDevice()
            ?: return false
        val mgr = usbManager ?: return false
        var conn: UsbDeviceConnection? = null
        try {
            conn = mgr.openDevice(device) ?: return false
            val value = db256.coerceIn(VOLUME_MIN_DB256, VOLUME_MAX_DB256)
            val buffer = byteArrayOf(
                (value and 0xFF).toByte(),
                ((value shr 8) and 0xFF).toByte()
            )
            val wValue = (VOLUME_CONTROL shl 8) or 0 // channel 0 = master
            val wIndex = (fid shl 8) or audioControlIface
            val ret = conn.controlTransfer(
                REQ_TYPE_CLASS_INTERFACE_OUT,
                REQ_SET_CUR,
                wValue,
                wIndex,
                buffer, buffer.size,
                1000 // timeout 1s
            )
            return ret == buffer.size
        } catch (_: Exception) {
            return false
        } finally {
            try { conn?.close() } catch (_: Exception) {}
        }
    }

    /**
     * Đọc volume hiện tại từ DAC (GET_CUR).
     * @return dB*256, null nếu lỗi
     */
    fun getVolumeDb256(): Int? {
        val fuId = featureUnitId ?: return null
        val device = UsbAudioDevice.getInstance(context).findUsbAudioDevice()
            ?: return null
        val mgr = usbManager ?: return null
        var conn: UsbDeviceConnection? = null
        try {
            conn = mgr.openDevice(device) ?: return null
            val buffer = ByteArray(2)
            val wValue = (VOLUME_CONTROL shl 8) or 0
            val wIndex = (fuId shl 8) or audioControlIface
            val ret = conn.controlTransfer(
                0xA1, // REQ_TYPE_CLASS_INTERFACE_IN
                0x81, // GET_CUR
                wValue,
                wIndex,
                buffer, buffer.size,
                1000
            )
            if (ret != 2) return null
            val raw = (buffer[0].toInt() and 0xFF) or ((buffer[1].toInt()) shl 8)
            // Sign-extend 16-bit
            return if (raw and 0x8000 != 0) raw - 0x10000 else raw
        } catch (_: Exception) {
            return null
        } finally {
            try { conn?.close() } catch (_: Exception) {}
        }
    }
}
