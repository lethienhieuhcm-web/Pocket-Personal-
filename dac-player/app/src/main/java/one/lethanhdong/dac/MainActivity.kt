package one.lethanhdong.dac

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
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
import one.lethanhdong.dac.player.CoverArt
import one.lethanhdong.dac.player.DriveTokenInvalidException
import one.lethanhdong.dac.player.MusicApiClient
import one.lethanhdong.dac.player.PlayerManager
import one.lethanhdong.dac.player.TrackAdapter

/**
 * MainActivity — plan "dac-pass" (Chốt 2026-10-13) + dac-app 1.3.
 *
 * 1.3: CHỈ thư viện + phát nhạc. Auth tách sang AuthActivity —
 * MainActivity chỉ chạy khi đã đăng nhập (chưa đăng nhập → về AuthActivity).
 * Đăng xuất: nút "Đăng xuất" → POST /api/auth/logout + xoá local → AuthActivity.
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

        authManager = AuthManager(this)
        // 1.3: MainActivity chỉ chạy khi đã đăng nhập — chưa đăng nhập → AuthActivity
        if (!authManager.isLoggedIn()) {
            startActivity(Intent(this, AuthActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)

        // Y chang doc ma145 — phải gọi trước khi làm gì khác với USB.
        UsbAudioPermissionHelper.handleIntent(applicationContext, intent)

        playerManager = PlayerManager(this)
        apiClient = MusicApiClient(this)
        driveAuthManager = one.lethanhdong.dac.player.DriveAuthManager(this)

        statusText = findViewById(R.id.statusText)
        trackList = findViewById(R.id.trackList)

        // Hiện version để user biết đang dùng bản nào (dac-pass 2026-10-13)
        try {
            val pInfo = packageManager.getPackageInfo(packageName, 0)
            val versionName = pInfo.versionName ?: "?"
            findViewById<TextView>(R.id.versionText)?.text = "v$versionName"
        } catch (e: Exception) {
            // Không lấy được version → bỏ qua, không crash
        }

        trackAdapter = TrackAdapter(
            onTrackClick = { track -> playTrack(track) },
            // 1.4: ImageLoader ảnh bìa (Coil + CoverArtFetcher).
            imageLoader = CoverArt.imageLoader(this, apiClient),
        )
        trackList.layoutManager = LinearLayoutManager(this)
        trackList.adapter = trackAdapter

        findViewById<Button>(R.id.pickButton).setOnClickListener {
            pickAudio.launch("audio/*")
        }
        findViewById<Button>(R.id.playPauseButton).setOnClickListener {
            playerManager.togglePlayPause()
        }
        findViewById<Button>(R.id.logoutButton).setOnClickListener {
            doLogout()
        }
        findViewById<Button>(R.id.licensesButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, LicensesActivity::class.java))
        }
        // 2.1: Nhập nhạc từ Drive share link
        findViewById<Button>(R.id.importButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, ImportActivity::class.java))
        }

        refreshAuthUi()
    }

    private fun refreshAuthUi() {
        // 1.3: tới đây là đã đăng nhập (onCreate đã gate). Chỉ còn Drive + track list.
        if (apiClient.isDriveConnected()) {
            statusText.text = "Đã đăng nhập: ${authManager.email()}\nCắm DAC USB để phát bit-perfect"
            loadTracks()
        } else {
            statusText.text = "Đã đăng nhập. Bấm 'Kết nối Drive' để duyệt nhạc."
            showDriveConnectPrompt()
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

    private fun doLogout() {
        lifecycleScope.launch {
            authManager.logout()
            startActivity(Intent(this@MainActivity, AuthActivity::class.java))
            finish()
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
            } catch (e: DriveTokenInvalidException) {
                statusText.text = e.message
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

    override fun onResume() {
        super.onResume()
        // 2.1: về từ ImportActivity → refresh library (có thể đã copy file mới)
        if (::apiClient.isInitialized && apiClient.isDriveConnected()) {
            loadTracks(forceRefresh = true)
        }
    }

    override fun onDestroy() {
        // 1.3: onCreate có thể return sớm (chưa đăng nhập → AuthActivity)
        // → playerManager chưa init, không được release.
        if (::playerManager.isInitialized) playerManager.release()
        super.onDestroy()
    }
}
