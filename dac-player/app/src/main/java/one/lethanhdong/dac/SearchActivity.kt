package one.lethanhdong.dac

import android.net.Uri
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.CoverArt
import one.lethanhdong.dac.player.DriveTokenInvalidException
import one.lethanhdong.dac.player.MusicApiClient
import one.lethanhdong.dac.player.OfflineManager
import one.lethanhdong.dac.player.PlayerManager
import one.lethanhdong.dac.player.TrackAdapter
import javax.inject.Inject

/**
 * 4.8: Tìm kiếm metadata (D1 index) — trang riêng, không modal.
 * Phân trang: tự tải thêm khi cuộn gần cuối. Bấm bài → phát + prefetch queue (4.5).
 */
@dagger.hilt.android.AndroidEntryPoint
class SearchActivity : AppCompatActivity() {

    @Inject lateinit var playerManager: dagger.Lazy<PlayerManager>
    @Inject lateinit var offlineManager: dagger.Lazy<OfflineManager>

    private lateinit var apiClient: MusicApiClient
    private lateinit var trackAdapter: TrackAdapter
    private lateinit var statusText: TextView
    private lateinit var searchInput: EditText

    private val results = mutableListOf<MusicApiClient.Track>()
    private var total = 0
    private var loading = false
    private var currentQuery = ""
    private val pageSize = 50

    private var prefetchJob: Job? = null
    private var currentPlayingTitle: String? = null
    private val downloadedIds = mutableSetOf<String>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_search)
        apiClient = MusicApiClient(this)
        statusText = findViewById(R.id.searchStatus)
        searchInput = findViewById(R.id.searchInput)

        trackAdapter = TrackAdapter(
            onTrackClick = { track -> playTrack(track) },
            imageLoader = CoverArt.imageLoader(this, apiClient),
            onDownloadClick = { track -> downloadTrack(track) },
            isDownloaded = { id -> downloadedIds.contains(id) },
        )
        val layoutManager = LinearLayoutManager(this)
        findViewById<RecyclerView>(R.id.searchResultsList).apply {
            this.layoutManager = layoutManager
            adapter = trackAdapter
            // 4.8: tải thêm khi cuộn gần cuối (còn kết quả)
            addOnScrollListener(object : RecyclerView.OnScrollListener() {
                override fun onScrolled(rv: RecyclerView, dx: Int, dy: Int) {
                    if (dy <= 0 || loading) return
                    val visible = layoutManager.childCount
                    val first = layoutManager.findFirstVisibleItemPosition()
                    val totalItems = layoutManager.itemCount
                    if (first + visible >= totalItems - 5 && totalItems < total) {
                        loadMore()
                    }
                }
            })
        }

        searchInput.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                doSearch()
                true
            } else false
        }
        findViewById<Button>(R.id.searchButton).setOnClickListener { doSearch() }
        findViewById<Button>(R.id.searchBackButton).setOnClickListener { finish() }

        refreshDownloaded()

        // 4.4/4.5: cập nhật title khi queue chuyển bài
        lifecycleScope.launch {
            playerManager.get().currentTitle.collect { t ->
                if (t != null) currentPlayingTitle = t
            }
        }
        lifecycleScope.launch {
            playerManager.get().audioQuality.collect { q ->
                val t = currentPlayingTitle
                if (q != null && t != null) {
                    statusText.text = "Đang phát: $t — ${q.badgeText()}"
                }
            }
        }
    }

    private fun doSearch() {
        val q = searchInput.text.toString().trim()
        if (q.isEmpty()) {
            Toast.makeText(this, "Nhập từ khoá tìm kiếm", Toast.LENGTH_SHORT).show()
            return
        }
        currentQuery = q
        results.clear()
        trackAdapter.submitList(emptyList())
        loadMore()
    }

    /** 4.8: tải 1 trang kết quả (offset = số đã có). */
    private fun loadMore() {
        if (loading || currentQuery.isEmpty()) return
        loading = true
        statusText.text = "Đang tìm…"
        lifecycleScope.launch {
            try {
                val res = apiClient.search(
                    currentQuery, limit = pageSize, offset = results.size,
                    activity = this@SearchActivity,
                )
                total = res.total
                results.addAll(res.tracks)
                trackAdapter.submitList(results.toList())
                val shown = results.size
                statusText.text = if (total >= 0) {
                    "Tìm thấy $total kết quả (đang hiện $shown)."
                } else {
                    "Tìm thấy $shown kết quả."
                }
            } catch (e: DriveTokenInvalidException) {
                statusText.text = e.message
            } catch (e: Exception) {
                statusText.text = "Lỗi tìm kiếm: ${e.message}"
            } finally {
                loading = false
            }
        }
    }

    private fun playTrack(track: MusicApiClient.Track) {
        prefetchJob?.cancel()
        lifecycleScope.launch {
            try {
                val local = offlineManager.get().localFile(track.id)
                if (local != null) {
                    currentPlayingTitle = track.title
                    statusText.text = "Đang phát offline: ${track.title}"
                    playerManager.get().playSingleLocal(Uri.fromFile(local), track.title)
                } else {
                    statusText.text = "Đang tải: ${track.title}"
                    val url = apiClient.streamUrl(track.id, this@SearchActivity)
                    currentPlayingTitle = track.title
                    statusText.text = "Đang phát: ${track.title}"
                    playerManager.get().playSingleStream(url, track.title)
                }
                prefetchNext(track.id)
            } catch (e: Exception) {
                Toast.makeText(this@SearchActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    /** 4.5: prefetch các bài sau trong kết quả tìm kiếm vào queue. */
    private fun prefetchNext(currentId: String) {
        prefetchJob = lifecycleScope.launch {
            try {
                val idx = results.indexOfFirst { it.id == currentId }
                if (idx < 0) return@launch
                for (t in results.drop(idx + 1).take(5)) {
                    ensureActive()
                    val local = offlineManager.get().localFile(t.id)
                    if (local != null) {
                        playerManager.get().enqueueLocal(Uri.fromFile(local), t.title)
                    } else {
                        val url = apiClient.streamUrl(t.id, this@SearchActivity)
                        playerManager.get().enqueueStream(url, t.title)
                    }
                }
            } catch (e: Exception) {
                // Prefetch lỗi → bỏ qua
            }
        }
    }

    private fun downloadTrack(track: MusicApiClient.Track) {
        lifecycleScope.launch {
            try {
                val mgr = offlineManager.get()
                if (mgr.isDownloaded(track.id)) {
                    mgr.delete(track.id)
                    downloadedIds.remove(track.id)
                    Toast.makeText(this@SearchActivity, "Đã xoá bản offline", Toast.LENGTH_SHORT).show()
                } else {
                    statusText.text = "Đang tải: ${track.title}"
                    val url = apiClient.streamUrl(track.id, this@SearchActivity)
                    mgr.download(track.id, track.title, url)
                    downloadedIds.add(track.id)
                    Toast.makeText(this@SearchActivity, "Đã tải xong", Toast.LENGTH_SHORT).show()
                }
                trackAdapter.notifyDataSetChanged()
            } catch (e: Exception) {
                Toast.makeText(this@SearchActivity, e.message, Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun refreshDownloaded() {
        lifecycleScope.launch {
            try {
                downloadedIds.clear()
                downloadedIds.addAll(offlineManager.get().downloadedTracks().map { it.trackId })
            } catch (e: Exception) {
                // bỏ qua
            }
        }
    }
}
