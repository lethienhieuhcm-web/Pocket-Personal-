package one.lethanhdong.dac

import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.util.UnstableApi
import androidx.recyclerview.widget.ConcatAdapter
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.BreadcrumbItem
import one.lethanhdong.dac.player.CoverArt
import one.lethanhdong.dac.player.DriveFolder
import one.lethanhdong.dac.player.DriveTokenInvalidException
import one.lethanhdong.dac.player.FolderAdapter
import one.lethanhdong.dac.player.MusicApiClient
import one.lethanhdong.dac.player.PlayerManager
import one.lethanhdong.dac.player.OfflineManager
import one.lethanhdong.dac.player.TrackAdapter
import javax.inject.Inject

/**
 * FolderActivity — dac-app 4.1: duyệt nhạc theo thư mục Drive.
 *
 * - Gọi GET /api/dac/folders?parentId=... qua MusicApiClient.listFolders().
 * - Breadcrumb bấm được để nhảy tới cấp bất kỳ; nút "Lên 1 cấp" + nút back
 *   của hệ thống đi ngược 1 cấp (hết stack thì đóng màn hình).
 * - Bấm track → phát qua PlayerManager singleton (chung với MainActivity,
 *   nhạc không dừng khi chuyển màn hình).
 */
@UnstableApi
@AndroidEntryPoint
class FolderActivity : AppCompatActivity() {

    @Inject
    lateinit var playerManager: dagger.Lazy<PlayerManager>

    /** 4.3: quản lý file offline. */
    @Inject
    lateinit var offlineManager: dagger.Lazy<OfflineManager>

    /** ID các track đã tải offline — để hiện trạng thái nút tải. */
    private val downloadedIds = mutableSetOf<String>()

    private lateinit var apiClient: MusicApiClient
    private lateinit var folderAdapter: FolderAdapter
    private lateinit var trackAdapter: TrackAdapter
    private lateinit var breadcrumbBar: LinearLayout
    private lateinit var statusText: TextView

    /** Stack điều hướng: mỗi phần tử là parentId đã thăm. */
    private val navStack = ArrayDeque<String>()
    private var currentId: String = "root"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_folder)
        title = getString(R.string.folder_title)

        apiClient = MusicApiClient(this)

        breadcrumbBar = findViewById(R.id.breadcrumbBar)
        statusText = findViewById(R.id.folderStatusText)

        folderAdapter = FolderAdapter(onFolderClick = { folder -> drillDown(folder) })
        trackAdapter = TrackAdapter(
            onTrackClick = { track -> playTrack(track) },
            imageLoader = CoverArt.imageLoader(this, apiClient),
            onDownloadClick = { track -> downloadTrack(track) },
            isDownloaded = { id -> downloadedIds.contains(id) },
        )
        findViewById<RecyclerView>(R.id.folderContentList).apply {
            layoutManager = LinearLayoutManager(this@FolderActivity)
            adapter = ConcatAdapter(folderAdapter, trackAdapter)
        }

        findViewById<Button>(R.id.folderBackButton).setOnClickListener { navigateUp() }
        findViewById<Button>(R.id.folderPlayPauseButton).setOnClickListener {
            playerManager.get().togglePlayPause()
        }

        // 4.2: Đồng bộ index trước khi duyệt (lần đầu full scan, sau incremental).
        syncAndLoad()
    }

    private fun syncAndLoad() {
        statusText.text = "Đang đồng bộ thư viện…"
        lifecycleScope.launch {
            try {
                val r = apiClient.syncIndex(this@FolderActivity)
                statusText.text =
                    if (r.full) "Đã đồng bộ ${r.total} file (lần đầu)."
                    else "Đã đồng bộ (${r.synced} thay đổi)."
            } catch (e: DriveTokenInvalidException) {
                statusText.text = e.message
                return@launch
            } catch (e: Exception) {
                // Sync lỗi → vẫn duyệt bằng live Drive (fallback ở Worker)
                statusText.text = "Đồng bộ lỗi, dùng dữ liệu trực tiếp."
            }
            loadFolder("root")
        }
    }

    private fun loadFolder(parentId: String) {
        currentId = parentId
        statusText.text = "Đang tải…"
        lifecycleScope.launch {
            try {
                val listing = apiClient.listFolders(parentId, this@FolderActivity)
                folderAdapter.submitList(listing.folders)
                trackAdapter.submitList(listing.tracks)
                refreshDownloadedState(listing.tracks.map { it.id })
                trackAdapter.notifyDataSetChanged()
                renderBreadcrumb(listing.breadcrumb)
                statusText.text =
                    "${listing.folders.size} thư mục • ${listing.tracks.size} bài"
            } catch (e: DriveTokenInvalidException) {
                statusText.text = e.message
                folderAdapter.submitList(emptyList())
                trackAdapter.submitList(emptyList())
            } catch (e: Exception) {
                statusText.text = "Không tải được: ${e.message}"
            }
        }
    }

    private fun renderBreadcrumb(crumbs: List<BreadcrumbItem>) {
        breadcrumbBar.removeAllViews()
        crumbs.forEachIndexed { i, crumb ->
            if (i > 0) {
                val sep = TextView(this).apply { text = " / " }
                breadcrumbBar.addView(sep)
            }
            val btn = Button(this, null, android.R.attr.borderlessButtonStyle).apply {
                text = crumb.name.ifEmpty { "Drive" }
                setOnClickListener { jumpTo(crumb.id) }
            }
            // Bỏ padding mặc định của Button để breadcrumb gọn
            btn.setPadding(8, 4, 8, 4)
            breadcrumbBar.addView(
                btn,
                LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }
    }

    private fun drillDown(folder: DriveFolder) {
        navStack.addLast(currentId)
        loadFolder(folder.id)
    }

    private fun jumpTo(id: String) {
        // Nhảy tới crumb: cắt stack về đúng vị trí (tìm id trong stack + current)
        val trail = navStack.toList() + currentId
        val idx = trail.indexOf(id)
        if (idx >= 0) {
            repeat(trail.size - 1 - idx) { navStack.removeLast() }
        } else {
            navStack.clear()
        }
        loadFolder(id)
    }

    private fun navigateUp() {
        if (navStack.isEmpty()) {
            finish()
        } else {
            loadFolder(navStack.removeLast())
        }
    }

    @Deprecated("Dùng OnBackPressedDispatcher trên Android 13+")
    override fun onBackPressed() {
        // Đi ngược cây thư mục trước khi thoát màn hình
        if (navStack.isEmpty()) super.onBackPressed() else navigateUp()
    }

    private fun playTrack(track: MusicApiClient.Track) {
        lifecycleScope.launch {
            try {
                // 4.3: ưu tiên file offline đã tải.
                val local = offlineManager.get().localFile(track.id)
                if (local != null) {
                    statusText.text = "Đang phát offline: ${track.title}"
                    playerManager.get().playLocal(Uri.fromFile(local))
                    return@launch
                }
                statusText.text = "Đang tải: ${track.title}"
                val url = apiClient.streamUrl(track.id, this@FolderActivity)
                statusText.text = "Đang phát: ${track.title}"
                playerManager.get().playStream(url)
            } catch (e: Exception) {
                Toast.makeText(
                    this@FolderActivity,
                    e.message ?: "Lỗi phát nhạc",
                    Toast.LENGTH_LONG,
                ).show()
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
                val url = apiClient.streamUrl(track.id, this@FolderActivity)
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
                Toast.makeText(
                    this@FolderActivity,
                    e.message ?: "Lỗi tải về",
                    Toast.LENGTH_LONG,
                ).show()
            }
        }
    }

    /** 4.3: refresh trạng thái đã tải sau khi load danh sách. */
    private suspend fun refreshDownloadedState(trackIds: List<String>) {
        val all = offlineManager.get().downloadedTracks().map { it.trackId }.toSet()
        downloadedIds.clear()
        downloadedIds.addAll(trackIds.filter { all.contains(it) })
    }
}
