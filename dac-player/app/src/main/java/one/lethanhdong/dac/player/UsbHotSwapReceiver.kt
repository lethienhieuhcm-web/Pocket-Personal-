package one.lethanhdong.dac.player

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.widget.Toast

/**
 * UsbHotSwapReceiver — xử lý rút/cắm DAC USB giữa chừng (P3 7.7).
 *
 * Pattern tham khảo:
 * - Neutron: NeutronMPUsbEnumerator bắt USB_DEVICE_ATTACHED/DETACHED
 * - UAPP: message USBDetached riêng cho UI
 *
 * Hành vi:
 * - Rút DAC đang dùng → dừng phát, báo user
 * - Cắm lại cùng DAC (cùng vid/pid) → tự nối lại
 * - Cắm DAC khác → báo cần restart app (lib singleton không hot-swap)
 *
 * Đăng ký trong Activity.onResume, hủy trong onPause.
 */
class UsbHotSwapReceiver(
    private val context: Context,
    private val onDacDetached: () -> Unit,
    private val onSameDacReattached: (UsbDevice) -> Unit,
    private val onDifferentDacAttached: (UsbDevice) -> Unit,
) : BroadcastReceiver() {

    companion object {
        const val ACTION_USB_ATTACHED = UsbManager.ACTION_USB_DEVICE_ATTACHED
        const val ACTION_USB_DETACHED = UsbManager.ACTION_USB_DEVICE_DETACHED
    }

    /** vid/pid của DAC đang dùng, null nếu chưa có. */
    var currentDacKey: String? = null

    private val filter = IntentFilter().apply {
        addAction(ACTION_USB_ATTACHED)
        addAction(ACTION_USB_DETACHED)
    }

    fun register() {
        context.registerReceiver(this, filter)
    }

    fun unregister() {
        try {
            context.unregisterReceiver(this)
        } catch (_: IllegalArgumentException) {
            // Chưa đăng ký — bỏ qua
        }
    }

    override fun onReceive(ctx: Context, intent: Intent) {
        val device: UsbDevice? =
            intent.getParcelableExtra(UsbManager.EXTRA_DEVICE)
        if (device == null) return

        // Chỉ quan tâm thiết bị USB audio
        if (!isUsbAudioDevice(device)) return

        val dacKey = DacSettings.dacKey(device.vendorId, device.productId)

        when (intent.action) {
            ACTION_USB_DETACHED -> {
                if (dacKey == currentDacKey) {
                    currentDacKey = null
                    onDacDetached()
                    Toast.makeText(
                        ctx,
                        "Đã ngắt kết nối DAC",
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
            ACTION_USB_ATTACHED -> {
                when {
                    currentDacKey == null -> {
                        // Chưa có DAC — nhận luôn
                        currentDacKey = dacKey
                        onSameDacReattached(device)
                    }
                    dacKey == currentDacKey -> {
                        // Cắm lại cùng DAC — tự nối lại
                        onSameDacReattached(device)
                        Toast.makeText(
                            ctx,
                            "Đã kết nối lại DAC",
                            Toast.LENGTH_SHORT
                        ).show()
                    }
                    else -> {
                        // DAC khác — cần restart app
                        onDifferentDacAttached(device)
                    }
                }
            }
        }
    }

    /**
     * Kiểm tra có phải thiết bị USB audio không.
     * DAC thường có interface class AUDIO (1).
     */
    private fun isUsbAudioDevice(device: UsbDevice): Boolean {
        for (i in 0 until device.interfaceCount) {
            val intf = device.getInterface(i)
            // USB_CLASS_AUDIO = 1
            if (intf.interfaceClass == 1) return true
        }
        return false
    }
}
