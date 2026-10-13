package one.lethanhdong.dac

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.util.UnstableApi
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.decent.usbaudio.UsbAudioPermissionHelper
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.AuthManager
import one.lethanhdong.dac.player.MusicApiClient
import one.lethanhdong.dac.player.PlayerManager
import one.lethanhdong.dac.player.TrackAdapter

/**
 * MainActivity — plan "dac-pass" (Chốt 2026-10-13).
 *
 * Xử lý USB intent y chang doc Ma145/decent-player (GETTING_STARTED.md
 * "Handle USB Device Attach").
 *
 * dac-pass: đăng nhập Pocket Personal → kết nối Google Drive (AccountManager)
 * → duyệt danh sách nhạc từ Drive → phát qua USB DAC.
 * D1 (file local) vẫn giữ để test không cần mạng.
 */
@UnstableApi
class MainActivity : AppCompatActivity() {

    private lateinit var playerManager: PlayerManager
    private lateinit var authManager: AuthManager
    private lateinit var apiClient: MusicApiClient
    private lateinit var driveAuthManager: one.lethanhdong.dac.player.DriveAuthManager
    private lateinit var trackAdapter: TrackAdapter

    private lateinit var statusText: TextView
    private lateinit var loginForm: LinearLayout
    private lateinit var trackList: RecyclerView

    private val pickAudio = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            statusText.text = "Đang phát local: ${it.lastPathSegment}"
            playerManager.playLocal(it)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Y chang doc ma145 — phải gọi trước khi làm gì khác với USB.
        UsbAudioPermissionHelper.handleIntent(applicationContext, intent)

        playerManager = PlayerManager(this)
        authManager = AuthManager(this)
        apiClient = MusicApiClient(this)
        driveAuthManager = one.lethanhdong.dac.player.DriveAuthManager(this)

        statusText = findViewById(R.id.statusText)
        loginForm = findViewById(R.id.loginForm)
        trackList = findViewById(R.id.trackList)

        trackAdapter = TrackAdapter { track -> playTrack(track) }
        trackList.layoutManager = LinearLayoutManager(this)
        trackList.adapter = trackAdapter

        findViewById<Button>(R.id.pickButton).setOnClickListener {
            pickAudio.launch("audio/*")
        }
        findViewById<Button>(R.id.playPauseButton).setOnClickListener {
            playerManager.togglePlayPause()
        }
        findViewById<Button>(R.id.loginButton).setOnClickListener {
            doLogin()
        }

        refreshAuthUi()
    }

    private fun refreshAuthUi() {
        if (authManager.isLoggedIn()) {
            loginForm.visibility = View.GONE
            trackList.visibility = View.VISIBLE
            if (apiClient.isDriveConnected()) {
                statusText.text = "Đã đăng nhập: ${authManager.email()}\nCắm DAC USB để phát bit-perfect"
                loadTracks()
            } else {
                statusText.text = "Đã đăng nhập. Bấm 'Kết nối Drive' để duyệt nhạc."
                showDriveConnectPrompt()
            }
        } else {
            loginForm.visibility = View.VISIBLE
            trackList.visibility = View.GONE
            statusText.text = "Đăng nhập để duyệt nhạc trên Google Drive"
        }
    }

    private fun showDriveConnectPrompt() {
        lifecycleScope.launch {
            val accounts = driveAuthManager.googleAccounts()
            if (accounts.isEmpty()) {
                statusText.text = "Không tìm thấy tài khoản Google trên máy.\nThêm tài khoản Google trong Cài đặt hệ thống."
                return@launch
            }
            // Tự động chọn tài khoản đầu tiên (đơn giản cho MVP)
            // TODO: UI chọn tài khoản khi có nhiều
            val account = accounts.first()
            driveAuthManager.selectAccount(account.name)
            Toast.makeText(
                this@MainActivity,
                "Đã kết nối Drive: ${account.name}",
                Toast.LENGTH_SHORT
            ).show()
            refreshAuthUi()
        }
    }

    private fun doLogin() {
        val email = findViewById<EditText>(R.id.emailInput).text.toString()
        val password = findViewById<EditText>(R.id.passwordInput).text.toString()
        if (email.isBlank() || password.isBlank()) {
            Toast.makeText(this, "Nhập email và mật khẩu", Toast.LENGTH_SHORT).show()
            return
        }
        lifecycleScope.launch {
            try {
                authManager.login(email, password)
                Toast.makeText(this@MainActivity, "Đăng nhập thành công", Toast.LENGTH_SHORT).show()
                refreshAuthUi()
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, e.message ?: "Lỗi đăng nhập", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun loadTracks(forceRefresh: Boolean = false) {
        lifecycleScope.launch {
            try {
                val tracks = apiClient.listMusic(forceRefresh, this@MainActivity)
                trackAdapter.submitList(tracks)
                if (tracks.isEmpty()) {
                    statusText.text = "Chưa có file nhạc trên Google Drive"
                }
            } catch (e: Exception) {
                statusText.text = "Không tải được danh sách: ${e.message}"
            }
        }
    }

    private fun playTrack(track: MusicApiClient.Track) {
        lifecycleScope.launch {
            try {
                statusText.text = "Đang tải: ${track.title}"
                val url = apiClient.streamUrl(track.id, this@MainActivity)
                statusText.text = "Đang phát: ${track.title}"
                playerManager.playStream(url)
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, e.message ?: "Lỗi phát nhạc", Toast.LENGTH_LONG).show()
            }
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
