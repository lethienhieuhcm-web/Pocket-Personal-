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
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.AuthManager
import one.lethanhdong.dac.player.CoverArt
import one.lethanhdong.dac.player.DriveTokenInvalidException
import one.lethanhdong.dac.player.MusicApiClient
import one.lethanhdong.dac.player.PlayerManager
import one.lethanhdong.dac.player.OfflineManager
import one.lethanhdong.dac.player.TrackAdapter
import one.lethanhdong.dac.player.UsbHotSwapReceiver
import javax.inject.Inject

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
@AndroidEntryPoint
class MainActivity : AppCompatActivity() {

    /**
     * 4.1: PlayerManager singleton (Hilt) — chung với FolderActivity.
     * Nhạc tiếp tục phát khi chuyển màn hình; không release ở onDestroy nữa
     * (singleton sống theo application).
     */
    @Inject
    lateinit var playerManager: dagger.Lazy<PlayerManager>

    /** 4.3: quản lý file offline. */
    @Inject
    lateinit var offlineManager: dagger.Lazy<OfflineManager>

    /** ID các track đã tải offline — để hiện trạng thái nút tải. */
    private val downloadedIds = mutableSetOf<String>()

    /** 7.7: receiver xử lý rút/cắm DAC giữa chừng. */
    private var usbHotSwapReceiver: UsbHotSwapReceiver? = null

    /** Title track đang phát — để ghép badge chất lượng vào status. */
    private var currentPlayingTitle: String? = null

    /** AudioQuality hiện tại — để mở Signal Path dialog. */
    private var currentAudioQuality: one.lethanhdong.dac.player.PlayerManager.AudioQuality? = null

    /** Job prefetch queue — huỷ khi user chọn bài khác. */
    private var prefetchJob: kotlinx.coroutines.Job? = null

    private lateinit var authManager: AuthManager
    private lateinit var apiClient: MusicApiClient
    private lateinit var driveAuthManager: one.lethanhdong.dac.player.DriveAuthManager
    private lateinit var trackAdapter: TrackAdapter

    private lateinit var statusText: TextView
    private lateinit var trackList: RecyclerView
    private lateinit var tabSongs: Button
    private lateinit var tabAlbums: Button
    private lateinit var tabArtists: Button
    /** Redesign 80/20: toàn bộ tracks để nhóm theo album/nghệ sĩ */
    private var allTracks: List<MusicApiClient.Track> = emptyList()
    /** 0=Bài hát, 1=Album, 2=Nghệ sĩ */
    private var currentTab = 0

    private val pickAudio = registerForActivityResult(
        ActivityResultContracts.GetContent()
    ) { uri: Uri? ->
        uri?.let {
            statusText.text = "Đang phát local: ${it.lastPathSegment}"
            playerManager.get().playLocal(it)
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

        // 4.1: playerManager do Hilt inject (singleton), không khởi tạo tay nữa.
        apiClient = MusicApiClient(this)
        driveAuthManager = one.lethanhdong.dac.player.DriveAuthManager(this)

        statusText = findViewById(R.id.statusText)
        trackList = findViewById(R.id.trackList)

        // Signal Path: bấm vào status để xem chi tiết đường tín hiệu
        statusText.setOnClickListener {
            showSignalPathDialog()
        }

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
            onDownloadClick = { track -> downloadTrack(track) },
            isDownloaded = { id -> downloadedIds.contains(id) },
        )
        trackList.layoutManager = LinearLayoutManager(this)
        trackList.adapter = trackAdapter

        // Redesign 80/20: tabs Bài hát / Album / Nghệ sĩ
        tabSongs = findViewById(R.id.tabSongs)
        tabAlbums = findViewById(R.id.tabAlbums)
        tabArtists = findViewById(R.id.tabArtists)
        tabSongs.setOnClickListener { currentTab = 0; renderCurrentTab() }
        tabAlbums.setOnClickListener { currentTab = 1; renderCurrentTab() }
        tabArtists.setOnClickListener { currentTab = 2; renderCurrentTab() }

        findViewById<Button>(R.id.pickButton).setOnClickListener {
            pickAudio.launch("audio/*")
        }
        findViewById<Button>(R.id.playPauseButton).setOnClickListener {
            playerManager.get().togglePlayPause()
        }
        findViewById<Button>(R.id.logoutButton).setOnClickListener {
            doLogout()
        }
        // 4.7: Quản lý phiên đăng nhập
        findViewById<Button>(R.id.sessionsButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, SessionsActivity::class.java))
        }
        // 4.8: Tìm kiếm metadata
        findViewById<Button>(R.id.searchButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, SearchActivity::class.java))
        }
        // 4.9: Hàng chờ + hẹn giờ + playlist
        findViewById<Button>(R.id.queueButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, QueueActivity::class.java))
        }
        findViewById<Button>(R.id.licensesButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, LicensesActivity::class.java))
        }
        // 2.1: Nhập nhạc từ Drive share link
        findViewById<Button>(R.id.importButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, ImportActivity::class.java))
        }
        // 4.1: Duyệt nhạc theo thư mục Drive
        findViewById<Button>(R.id.folderButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, FolderActivity::class.java))
        }
        // Cài đặt DAC (spec P3 dòng 23: per-DAC settings)
        findViewById<Button>(R.id.dacSettingsButton).setOnClickListener {
            startActivity(Intent(this@MainActivity, DacSettingsActivity::class.java))
        }

        refreshAuthUi()

        // 4.4: hiện badge chất lượng nguồn → DAC khi đang phát.
        lifecycleScope.launch {
            playerManager.get().audioQuality.collect { q ->
                currentAudioQuality = q
                val t = currentPlayingTitle
                if (q != null && t != null) {
                    statusText.text = "Đang phát: $t — ${q.badgeText()}"
                }
            }
        }
        // 4.5: queue tự chuyển bài → cập nhật title đang phát.
        lifecycleScope.launch {
            playerManager.get().currentTitle.collect { t ->
                if (t != null) currentPlayingTitle = t
            }
        }
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
                val tracks = apiClient.listLibrary(forceRefresh, this@MainActivity)
                allTracks = tracks
                renderCurrentTab()
                refreshDownloadedState(tracks.map { it.id })
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

    /** Redesign 80/20: render theo tab đang chọn */
    private fun renderCurrentTab() {
        when (currentTab) {
            0 -> {
                // Bài hát: flat list
                trackAdapter.submitList(allTracks)
                trackAdapter.notifyDataSetChanged()
            }
            1 -> {
                // Album: nhóm và hiển thị tên album
                val albums = allTracks.groupBy {
                    it.album.ifEmpty { "(Chưa rõ album)" }
                }.toSortedMap()
                // Hiển thị dạng header: hiện tại dùng flat list với tên album
                trackAdapter.submitList(allTracks.sortedBy {
                    it.album.ifEmpty { "(Chưa rõ album)" }
                })
                trackAdapter.notifyDataSetChanged()
                statusText.text = "${albums.size} album • ${allTracks.size} bài"
            }
            2 -> {
                // Nghệ sĩ: nhóm theo artist
                val artists = allTracks.groupBy {
                    it.artist.ifEmpty { "(Chưa rõ nghệ sĩ)" }
                }.toSortedMap()
                trackAdapter.submitList(allTracks.sortedBy {
                    it.artist.ifEmpty { "(Chưa rõ nghệ sĩ)" }
                })
                trackAdapter.notifyDataSetChanged()
                statusText.text = "${artists.size} nghệ sĩ • ${allTracks.size} bài"
            }
        }
    }

    private fun playTrack(track: MusicApiClient.Track) {
        prefetchJob?.cancel()
        lifecycleScope.launch {
            try {
                // 4.3: ưu tiên file offline đã tải.
                val local = offlineManager.get().localFile(track.id)
                if (local != null) {
                    currentPlayingTitle = track.title
                    statusText.text = "Đang phát offline: ${track.title}"
                    playerManager.get().playSingleLocal(Uri.fromFile(local), track.title)
                } else {
                    statusText.text = "Đang tải: ${track.title}"
                    val url = apiClient.streamUrl(track.id, this@MainActivity)
                    currentPlayingTitle = track.title
                    statusText.text = "Đang phát: ${track.title}"
                    playerManager.get().playSingleStream(url, track.title)
                }
                // 4.5: prefetch 5 bài tiếp theo vào queue → chuyển bài gapless.
                prefetchNext(track.id)
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, e.message ?: "Lỗi phát nhạc", Toast.LENGTH_LONG).show()
            }
        }
    }

    /**
     * 4.5: Nạp trước URL của các bài sau bài đang phát vào queue.
     * ExoPlayer tự chuyển bài gapless khi cùng format. Giới hạn 5 bài.
     */
    private fun prefetchNext(currentId: String) {
        prefetchJob = lifecycleScope.launch {
            try {
                val list = trackAdapter.currentList
                val idx = list.indexOfFirst { it.id == currentId }
                if (idx < 0) return@launch
                for (t in list.drop(idx + 1).take(5)) {
                    ensureActive()
                    val local = offlineManager.get().localFile(t.id)
                    if (local != null) {
                        playerManager.get().enqueueLocal(Uri.fromFile(local), t.title)
                    } else {
                        val url = apiClient.streamUrl(t.id, this@MainActivity)
                        playerManager.get().enqueueStream(url, t.title)
                    }
                }
            } catch (e: Exception) {
                // Prefetch lỗi → bỏ qua
            }
        }
    }

    /** 4.3: Tải track về nghe offline. Bấm lần nữa khi đã tải = xoá. */
    private fun downloadTrack(track: MusicApiClient.Track) {
        lifecycleScope.launch {
            try {
                if (downloadedIds.contains(track.id)) {
                    offlineManager.get().delete(track.id)
                    downloadedIds.remove(track.id)
                    trackAdapter.notifyDataSetChanged()
                    statusText.text = "Đã xoá bản offline: ${track.title}"
                    return@launch
                }
                statusText.text = "Đang tải: ${track.title}"
                val url = apiClient.streamUrl(track.id, this@MainActivity)
                offlineManager.get().download(track.id, track.title, url) { done, total ->
                    if (total > 0) {
                        runOnUiThread {
                            statusText.text =
                                "Đang tải: ${track.title} — ${done * 100 / total}%"
                        }
                    }
                }
                downloadedIds.add(track.id)
                trackAdapter.notifyDataSetChanged()
                statusText.text = "Đã tải xong: ${track.title}"
            } catch (e: Exception) {
                Toast.makeText(this@MainActivity, e.message ?: "Lỗi tải về", Toast.LENGTH_LONG).show()
            }
        }
    }

    /** 4.3: refresh trạng thái đã tải sau khi load danh sách. */
    private suspend fun refreshDownloadedState(trackIds: List<String>) {
        val all = offlineManager.get().downloadedTracks().map { it.trackId }.toSet()
        downloadedIds.clear()
        downloadedIds.addAll(trackIds.filter { all.contains(it) })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Y chang doc ma145 — xử lý khi DAC được cắm lúc app đang chạy.
        UsbAudioPermissionHelper.handleIntent(applicationContext, intent)
        setIntent(intent)
    }

    private var isSyncing = false

    override fun onResume() {
        super.onResume()
        // 7.7: đăng ký receiver xử lý rút/cắm DAC
        if (usbHotSwapReceiver == null) {
            usbHotSwapReceiver = UsbHotSwapReceiver(
                context = this,
                onDacDetached = {
                    // Dừng phát khi rút DAC
                    playerManager.get().pauseIfPlaying()
                },
                onSameDacReattached = {
                    // Cùng DAC cắm lại — sẵn sàng phát tiếp, không cần làm gì thêm
                },
                onDifferentDacAttached = {
                    // DAC khác — báo user restart app
                    androidx.appcompat.app.AlertDialog.Builder(this)
                        .setTitle("Đã cắm DAC khác")
                        .setMessage("Cần khởi động lại app để sử dụng DAC mới.")
                        .setPositiveButton("Khởi động lại") { _, _ ->
                            finishAffinity()
                        }
                        .setNegativeButton("Để sau", null)
                        .show()
                }
            )
        }
        usbHotSwapReceiver?.register()
        // Đồng bộ thông minh: chỉ sync nếu cache cũ hơn 15 phút, chống gọi lồng nhau
        if (::apiClient.isInitialized && apiClient.isDriveConnected() && !isSyncing) {
            val stale = System.currentTimeMillis() - apiClient.lastSync > 15 * 60 * 1000
            if (stale) {
                isSyncing = true
                lifecycleScope.launch {
                    try {
                        apiClient.syncLibrary(this@MainActivity)
                    } finally {
                        isSyncing = false
                    }
                    loadTracks()
                }
            } else {
                loadTracks()
            }
        }
    }

    override fun onPause() {
        super.onPause()
        // 7.7: hủy đăng ký receiver khi activity không còn foreground
        usbHotSwapReceiver?.unregister()
    }

    override fun onDestroy() {
        // 4.1: playerManager là singleton (Hilt) — không release ở đây nữa.
        // Nhạc tiếp tục phát khi chuyển sang FolderActivity.
        super.onDestroy()
    }

    /**
     * Mở dialog Signal Path — hiện 5 khâu từ file đến DAC.
     * Lấy dữ liệu từ AudioQuality + DacSettings + UsbVolumeController.
     */
    private fun showSignalPathDialog() {
        val q = currentAudioQuality ?: return

        // Lấy USB device hiện tại
        val usbDevice = try {
            one.lethanhdong.dac.player.UsbVolumeController(this).let { ctrl ->
                // Lấy device từ UsbAudioDevice
                null // Sẽ lấy qua UsbManager
            }
        } catch (e: Exception) { null }

        val usbManager = getSystemService(android.content.Context.USB_SERVICE)
            as android.hardware.usb.UsbManager
        val device = usbManager.deviceList.values.firstOrNull { d ->
            // Tìm USB audio device (class 1)
            (0 until d.interfaceCount).any { i ->
                d.getInterface(i).interfaceClass == 1
            }
        }

        val vendorId = device?.vendorId ?: 0
        val productId = device?.productId ?: 0

        // Thu thập dữ liệu
        val volume = if (vendorId != 0) {
            one.lethanhdong.dac.player.DacSettings.getVolume(this, vendorId, productId)
        } else 100

        val hasHwVolume = try {
            one.lethanhdong.dac.player.UsbVolumeController(this).hasHardwareVolume
        } catch (e: Exception) { false }

        val bufferUrbs = one.lethanhdong.dac.player.DacSettings.getBufferUrbs(this)
        val dsdMethod = one.lethanhdong.dac.player.DacSettings.currentDsdMethod
        val dacName = device?.productName

        // Đánh giá
        val result = one.lethanhdong.dac.player.SignalPath.assess(
            fileFormat = q.formatLabel,
            bitDepth = q.bitDepth,
            sampleRateHz = q.sampleRateHz,
            channels = q.channels,
            dsdMethod = dsdMethod,
            volumePercent = volume,
            hasHardwareVolume = hasHwVolume,
            bufferUrbs = bufferUrbs,
            dacName = dacName,
            dacSampleRateHz = null // v1: dùng rate file làm proxy [suy luận]
        )

        one.lethanhdong.dac.player.SignalPathDialog(this, result).show()
    }
}
