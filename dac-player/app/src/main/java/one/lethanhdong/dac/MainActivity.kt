package one.lethanhdong.dac

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.util.UnstableApi
import com.decent.usbaudio.UsbAudioPermissionHelper
import one.lethanhdong.dac.player.PlayerManager

/**
 * MainActivity — D1 scaffold.
 *
 * Xử lý USB intent y chang doc Ma145/decent-player (GETTING_STARTED.md
 * "Handle USB Device Attach"): gọi UsbAudioPermissionHelper.handleIntent()
 * trong onCreate() và onNewIntent() để app claim DAC trước khi kernel
 * driver (snd-usb-audio) bind.
 *
 * D1: UI tối thiểu — chọn file audio local → phát qua USB DAC bit-perfect.
 */
@UnstableApi
class MainActivity : AppCompatActivity() {

    private lateinit var playerManager: PlayerManager
    private lateinit var statusText: TextView

    private val pickAudio = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            statusText.text = "Đang phát: ${it.lastPathSegment}"
            playerManager.playLocal(it)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Y chang doc ma145 — phải gọi trước khi làm gì khác với USB.
        UsbAudioPermissionHelper.handleIntent(applicationContext, intent)

        playerManager = PlayerManager(this)

        statusText = findViewById(R.id.statusText)
        statusText.text = "Cắm DAC USB → cấp quyền → chọn file FLAC để phát"

        findViewById<Button>(R.id.pickButton).setOnClickListener {
            pickAudio.launch("audio/*")
        }
        findViewById<Button>(R.id.playPauseButton).setOnClickListener {
            playerManager.togglePlayPause()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Y chang doc ma145 — xử lý khi DAC được cắm lúc app đang chạy.
        UsbAudioPermissionHelper.handleIntent(applicationContext, intent)
        setIntent(intent)
    }

    override fun onDestroy() {
        playerManager.release()
        super.onDestroy()
    }
}
