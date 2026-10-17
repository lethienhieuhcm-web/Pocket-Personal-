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

        setupVolumeControl(vendorId, productId)
        setupQuirkControls(vendorId, productId)
    }

    /**
     * Thiết lập UI quirk override (spec P3 7.6).
     *
     * Đối chiếu 3 app:
     * - UAPP: hardcode, user không sửa được
     * - Neutron: phơi ra UI (Force 1ms packet + mô tả khi nào dùng)
     * - HiBy: Activity riêng từng món (bus speed, sample/bit...)
     * - Quyết định: theo Neutron — mỗi quirk có mô tả khi nào cần dùng
     */
    private fun setupQuirkControls(vendorId: Int, productId: Int) {
        val quirks = one.lethanhdong.dac.player.DacQuirks

        // Helper: kiểm tra có phải user override không (để hiện badge)
        val prefs = getSharedPreferences("dac_quirks", MODE_PRIVATE)
        fun isCustom(type: String): Boolean =
            prefs.contains("${quirks.key(vendorId, productId)}:$type")

        fun updateBadge(badge: TextView, type: String) {
            badge.text = if (isCustom(type)) {
                getString(R.string.quirk_badge_custom)
            } else {
                getString(R.string.quirk_badge_default)
            }
        }

        // 1. Ép gói 1ms (Switch)
        val switch1ms = findViewById<android.widget.Switch>(R.id.quirk1msSwitch)
        val badge1ms = findViewById<TextView>(R.id.quirk1msBadge)
        switch1ms.isChecked = quirks.getQuirk(this, vendorId, productId, quirks.FORCE_1MS_PACKET) == "1"
        updateBadge(badge1ms, quirks.FORCE_1MS_PACKET)
        switch1ms.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                quirks.setUserOverride(this, vendorId, productId, quirks.FORCE_1MS_PACKET, "1")
            } else {
                quirks.clearUserOverride(this, vendorId, productId, quirks.FORCE_1MS_PACKET)
            }
            updateBadge(badge1ms, quirks.FORCE_1MS_PACKET)
        }

        // 2. Tốc độ bus (RadioGroup: 0=Auto, 1=Full, 2=High)
        val busGroup = findViewById<android.widget.RadioGroup>(R.id.quirkBusGroup)
        val badgeBus = findViewById<TextView>(R.id.quirkBusBadge)
        when (quirks.getQuirk(this, vendorId, productId, quirks.BUS_SPEED)) {
            "1" -> busGroup.check(R.id.quirkBusFull)
            "2" -> busGroup.check(R.id.quirkBusHigh)
            else -> busGroup.check(R.id.quirkBusAuto)
        }
        updateBadge(badgeBus, quirks.BUS_SPEED)
        busGroup.setOnCheckedChangeListener { _, checkedId ->
            val value = when (checkedId) {
                R.id.quirkBusFull -> "1"
                R.id.quirkBusHigh -> "2"
                else -> "0"
            }
            if (value == "0") {
                quirks.clearUserOverride(this, vendorId, productId, quirks.BUS_SPEED)
            } else {
                quirks.setUserOverride(this, vendorId, productId, quirks.BUS_SPEED, value)
            }
            updateBadge(badgeBus, quirks.BUS_SPEED)
        }

        // 3. Ép tần số mẫu (EditText)
        val rateInput = findViewById<android.widget.EditText>(R.id.quirkRateInput)
        val rateApply = findViewById<android.widget.Button>(R.id.quirkRateApply)
        val rateClear = findViewById<android.widget.Button>(R.id.quirkRateClear)
        rateInput.setText(quirks.getQuirk(this, vendorId, productId, quirks.FORCE_SAMPLE_RATE) ?: "")
        rateApply.setOnClickListener {
            val rate = rateInput.text.toString().trim()
            if (rate.isNotEmpty() && rate.toIntOrNull() != null && rate.toInt() > 0) {
                quirks.setUserOverride(this, vendorId, productId, quirks.FORCE_SAMPLE_RATE, rate)
                Toast.makeText(this, R.string.dsd_method_saved, Toast.LENGTH_SHORT).show()
            } else {
                Toast.makeText(this, R.string.quirk_rate_hint, Toast.LENGTH_SHORT).show()
            }
        }
        rateClear.setOnClickListener {
            quirks.clearUserOverride(this, vendorId, productId, quirks.FORCE_SAMPLE_RATE)
            rateInput.setText("")
            Toast.makeText(this, R.string.dsd_method_saved, Toast.LENGTH_SHORT).show()
        }

        // 4. Tắt DSD (Switch)
        val switchDsd = findViewById<android.widget.Switch>(R.id.quirkDsdSwitch)
        val badgeDsd = findViewById<TextView>(R.id.quirkDsdBadge)
        switchDsd.isChecked = quirks.getQuirk(this, vendorId, productId, quirks.DISABLE_DSD) == "1"
        updateBadge(badgeDsd, quirks.DISABLE_DSD)
        switchDsd.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                quirks.setUserOverride(this, vendorId, productId, quirks.DISABLE_DSD, "1")
            } else {
                quirks.clearUserOverride(this, vendorId, productId, quirks.DISABLE_DSD)
            }
            updateBadge(badgeDsd, quirks.DISABLE_DSD)
        }

        // 5. Chặn DAC (Switch)
        val switchBlock = findViewById<android.widget.Switch>(R.id.quirkBlockSwitch)
        val badgeBlock = findViewById<TextView>(R.id.quirkBlockBadge)
        switchBlock.isChecked = quirks.isBlocklisted(this, vendorId, productId)
        updateBadge(badgeBlock, quirks.BLOCKLIST)
        switchBlock.setOnCheckedChangeListener { _, isChecked ->
            if (isChecked) {
                quirks.setUserOverride(this, vendorId, productId, quirks.BLOCKLIST, "1")
            } else {
                quirks.clearUserOverride(this, vendorId, productId, quirks.BLOCKLIST)
            }
            updateBadge(badgeBlock, quirks.BLOCKLIST)
        }
    }

    /**
     * Thiết lập điều khiển hardware volume (spec P3 7.5).
     *
     * Đối chiếu 3 app:
     * - UAPP: có USBMixerUnit — hardware volume qua UAC Feature Unit
     * - HiBy: khóa volume USB để giữ bit-perfect
     * - Quyết định: cho phép như UAPP, mặc định 100 (bit-perfect)
     */
    private fun setupVolumeControl(vendorId: Int, productId: Int) {
        val volumeSection = findViewById<android.widget.LinearLayout>(R.id.volumeSection)
        val volumeSeekBar = findViewById<android.widget.SeekBar>(R.id.volumeSeekBar)
        val volumeLabel = findViewById<TextView>(R.id.volumeLabel)
        val volumeBadge = findViewById<TextView>(R.id.volumeBadge)

        val controller = one.lethanhdong.dac.player.UsbVolumeController(this)
        if (!controller.init()) {
            // DAC không có Feature Unit → ẩn volume control
            volumeSection.visibility = android.view.View.GONE
            return
        }

        volumeSection.visibility = android.view.View.VISIBLE

        // Đọc volume đã lưu (mặc định 100)
        var currentVolume = DacSettings.getVolume(this, vendorId, productId)
        volumeSeekBar.progress = currentVolume
        updateVolumeLabel(volumeLabel, volumeBadge, currentVolume)

        // Áp dụng volume đã lưu vào DAC
        controller.setVolume(currentVolume)

        volumeSeekBar.setOnSeekBarChangeListener(object : android.widget.SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: android.widget.SeekBar?, progress: Int, fromUser: Boolean) {
                if (!fromUser) return
                currentVolume = progress
                updateVolumeLabel(volumeLabel, volumeBadge, progress)
            }

            override fun onStartTrackingTouch(seekBar: android.widget.SeekBar?) {}

            override fun onStopTrackingTouch(seekBar: android.widget.SeekBar?) {
                // Chỉ gửi lệnh USB khi user thả tay (tránh spam controlTransfer)
                if (controller.setVolume(currentVolume)) {
                    DacSettings.setVolume(this@DacSettingsActivity, vendorId, productId, currentVolume)
                } else {
                    Toast.makeText(
                        this@DacSettingsActivity,
                        R.string.volume_set_failed,
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        })
    }

    private fun updateVolumeLabel(label: TextView, badge: TextView, volume: Int) {
        label.text = getString(R.string.volume_label_format, volume)
        badge.text = if (volume == 100) {
            getString(R.string.volume_badge_max)
        } else {
            getString(R.string.volume_badge_hardware)
        }
    }
}
