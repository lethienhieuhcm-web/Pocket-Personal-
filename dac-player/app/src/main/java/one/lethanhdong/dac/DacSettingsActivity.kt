package one.lethanhdong.dac

import android.os.Bundle
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import com.decent.usbaudio.UsbAudioDevice
import one.lethanhdong.dac.player.DacSettings

/**
 * Màn hình cài đặt per-DAC — spec P3 dòng 23.
 *
 * Hiển thị DAC đang cắm (tên, vendorId:productId) và cho chọn phương thức DSD:
 * - Native: DSD native (Phase 5, chưa implement → disable)
 * - DoP: DSD over PCM (mặc định, đã xong Phase 1)
 * - PCM: DSD→PCM fallback (cần FFmpeg LGPL, chưa xong → disable)
 *
 * Setting lưu theo key "vendorId:productId" — mỗi DAC nhớ riêng.
 */
class DacSettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_dac_settings)

        val dacInfoText = findViewById<TextView>(R.id.dacInfoText)
        val dsdMethodGroup = findViewById<RadioGroup>(R.id.dsdMethodGroup)
        val radioNative = findViewById<RadioButton>(R.id.radioNative)
        val radioDop = findViewById<RadioButton>(R.id.radioDop)
        val radioPcm = findViewById<RadioButton>(R.id.radioPcm)

        // Lấy DAC đang cắm
        val device = try {
            UsbAudioDevice.getInstance(this).findUsbAudioDevice()
        } catch (_: Exception) {
            null
        }

        if (device == null) {
            dacInfoText.text = getString(R.string.dac_not_connected)
            dsdMethodGroup.isEnabled = false
            radioNative.isEnabled = false
            radioDop.isEnabled = false
            radioPcm.isEnabled = false
            return
        }

        val vendorId = device.vendorId
        val productId = device.productId
        val dacName = device.productName ?: getString(R.string.dac_unknown)
        dacInfoText.text = getString(
            R.string.dac_info_format,
            dacName,
            DacSettings.dacKey(vendorId, productId)
        )

        // Disable option chưa implement (trung thực, không bịa)
        radioNative.isEnabled = false
        radioNative.text = getString(R.string.dsd_native_unavailable)
        radioPcm.isEnabled = false
        radioPcm.text = getString(R.string.dsd_pcm_unavailable)

        // Chọn theo setting đã lưu
        val current = DacSettings.getDsdMethod(this, vendorId, productId)
        when (current) {
            DacSettings.DSD_METHOD_NATIVE -> radioNative.isChecked = true
            DacSettings.DSD_METHOD_PCM -> radioPcm.isChecked = true
            else -> radioDop.isChecked = true
        }

        dsdMethodGroup.setOnCheckedChangeListener { _, checkedId ->
            val method = when (checkedId) {
                R.id.radioNative -> DacSettings.DSD_METHOD_NATIVE
                R.id.radioPcm -> DacSettings.DSD_METHOD_PCM
                else -> DacSettings.DSD_METHOD_DOP
            }
            DacSettings.setDsdMethod(this, vendorId, productId, method)
            Toast.makeText(this, R.string.dsd_method_saved, Toast.LENGTH_SHORT).show()
        }
    }
}
