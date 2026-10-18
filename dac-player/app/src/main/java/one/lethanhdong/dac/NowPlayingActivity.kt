package one.lethanhdong.dac

import android.os.Bundle
import android.content.Context
import android.view.View
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.PlayerManager
import one.lethanhdong.dac.player.SignalPath
import one.lethanhdong.dac.player.SignalPathDialog
import one.lethanhdong.dac.player.DacSettings
import one.lethanhdong.dac.player.UsbVolumeController
import javax.inject.Inject
import dagger.hilt.android.AndroidEntryPoint

/**
 * Màn hình Đang phát — thiết kế v4 (hướng HiBy).
 *
 * - Ảnh bìa lớn + nền blur
 * - Spec badges (FLAC, 24-bit, 96kHz, Stereo)
 * - Signal Path pill (bấm → dialog chi tiết)
 * - Progress bar + controls
 */
@AndroidEntryPoint
class NowPlayingActivity : AppCompatActivity() {

    @Inject
    lateinit var playerManager: dagger.Lazy<PlayerManager>

    private lateinit var albumArt: ImageView
    private lateinit var blurBackground: ImageView
    private lateinit var trackTitle: TextView
    private lateinit var trackArtist: TextView
    private lateinit var specBadges: LinearLayout
    private lateinit var signalPill: LinearLayout
    private lateinit var signalDot: View
    private lateinit var signalText: TextView
    private lateinit var progressBar: SeekBar
    private lateinit var currentTime: TextView
    private lateinit var totalTime: TextView

    private var currentQuality: PlayerManager.AudioQuality? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_now_playing)

        albumArt = findViewById(R.id.albumArt)
        blurBackground = findViewById(R.id.blurBackground)
        trackTitle = findViewById(R.id.trackTitle)
        trackArtist = findViewById(R.id.trackArtist)
        specBadges = findViewById(R.id.specBadges)
        signalPill = findViewById(R.id.signalPill)
        signalDot = findViewById(R.id.signalDot)
        signalText = findViewById(R.id.signalText)
        progressBar = findViewById(R.id.progressBar)
        currentTime = findViewById(R.id.currentTime)
        totalTime = findViewById(R.id.totalTime)

        findViewById<ImageButton>(R.id.backButton).setOnClickListener {
            finish()
        }

        // Bấm pill → mở Signal Path dialog
        signalPill.setOnClickListener {
            showSignalPathDialog()
        }

        // Theo dõi audio quality
        lifecycleScope.launch {
            playerManager.get().audioQuality.collect { q ->
                currentQuality = q
                updateUI(q)
            }
        }

        // Theo dõi title
        lifecycleScope.launch {
            playerManager.get().currentTitle.collect { t ->
                trackTitle.text = t ?: "Chưa phát"
            }
        }
    }

    private fun updateUI(q: PlayerManager.AudioQuality?) {
        if (q == null) {
            specBadges.removeAllViews()
            signalText.text = "Chưa phát"
            return
        }

        // Spec badges
        specBadges.removeAllViews()
        addBadge(q.formatLabel, true)
        q.bitDepth?.let { addBadge("$it-bit", true) }
        q.sampleRateHz?.let {
            val label = if (it % 1000 == 0) "${it/1000} kHz"
                        else String.format("%.1f kHz", it/1000f)
            addBadge(label, true)
        }
        q.channels?.let {
            val label = when (it) {
                1 -> "Mono"
                2 -> "Stereo"
                else -> "$it kênh"
            }
            addBadge(label, false)
        }

        // Signal Path pill
        updateSignalPill()
    }

    private fun addBadge(text: String, highlight: Boolean) {
        val badge = TextView(this).apply {
            this.text = text
            textSize = 11f
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setPadding(22, 10, 22, 10) // ~11px * 2
            background = if (highlight) {
                getDrawable(R.drawable.spec_badge_hi)
            } else {
                getDrawable(R.drawable.spec_badge)
            }
            setTextColor(
                if (highlight) 0xFF0D9D6C.toInt()
                else 0xFFE6EDF3.toInt()
            )
        }
        val params = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            marginEnd = 12 // 6px * 2
        }
        specBadges.addView(badge, params)
    }

    private fun updateSignalPill() {
        val q = currentQuality ?: return

        // Tính signal path nhanh để hiện pill
        val result = buildSignalPath(q)
        if (result.isBitPerfect) {
            signalDot.background = getDrawable(R.drawable.signal_dot_green)
            signalText.text = "Nguyên chất"
        } else {
            signalDot.background = getDrawable(R.drawable.signal_dot_yellow)
            signalText.text = "Đã chạm bits"
        }
    }

    private fun buildSignalPath(q: PlayerManager.AudioQuality): SignalPath.Result {
        val usbManager = getSystemService(Context.USB_SERVICE) as android.hardware.usb.UsbManager
        val device = usbManager.deviceList.values.firstOrNull { d ->
            (0 until d.interfaceCount).any { i ->
                d.getInterface(i).interfaceClass == 1
            }
        }

        val vendorId = device?.vendorId ?: 0
        val productId = device?.productId ?: 0
        val volume = if (vendorId != 0) {
            DacSettings.getVolume(this, vendorId, productId)
        } else 100

        val hasHwVolume = try {
            UsbVolumeController(this).hasHardwareVolume
        } catch (e: Exception) { false }

        return SignalPath.assess(
            fileFormat = q.formatLabel,
            bitDepth = q.bitDepth,
            sampleRateHz = q.sampleRateHz,
            channels = q.channels,
            dsdMethod = DacSettings.currentDsdMethod,
            volumePercent = volume,
            hasHardwareVolume = hasHwVolume,
            bufferUrbs = DacSettings.getBufferUrbs(this),
            dacName = device?.productName,
            dacSampleRateHz = null
        )
    }

    private fun showSignalPathDialog() {
        val q = currentQuality ?: return
        val result = buildSignalPath(q)
        SignalPathDialog(this, result).show()
    }
}
