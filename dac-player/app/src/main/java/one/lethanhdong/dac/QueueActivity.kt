package one.lethanhdong.dac

import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.MusicApiClient
import one.lethanhdong.dac.player.PlayerManager
import one.lethanhdong.dac.player.SleepTimer
import javax.inject.Inject

/**
 * 4.9: Hàng chờ + hẹn giờ ngủ + playlist — trang riêng (không modal/bottom sheet).
 * - Queue: kéo-thả đổi thứ tự, vuốt để xoá.
 * - Hẹn giờ: panel inline (Tắt/15/30/60/Hết bài).
 * - Playlist: lưu hàng chờ lên D1, mở lại trên mọi máy.
 */
@AndroidEntryPoint
class QueueActivity : AppCompatActivity() {

    @Inject
    lateinit var playerManager: dagger.Lazy<PlayerManager>

    @Inject
    lateinit var sleepTimer: SleepTimer

    private lateinit var apiClient: MusicApiClient
    private lateinit var queueAdapter: QueueAdapter
    private lateinit var playlistAdapter: PlaylistAdapter
    private lateinit var sleepStatus: TextView
    private lateinit var statusText: TextView
    private lateinit var playlistNameInput: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_queue)

        apiClient = MusicApiClient(this)
        sleepStatus = findViewById(R.id.sleepStatus)
        statusText = findViewById(R.id.queueStatus)
        playlistNameInput = findViewById(R.id.playlistNameInput)

        queueAdapter = QueueAdapter()
        val queueList = findViewById<RecyclerView>(R.id.queueList)
        queueList.layoutManager = LinearLayoutManager(this)
        queueList.adapter = queueAdapter
        ItemTouchHelper(queueTouchCallback()).attachToRecyclerView(queueList)

        playlistAdapter = PlaylistAdapter(
            onLoad = { p -> loadPlaylist(p) },
            onDelete = { p -> deletePlaylist(p) },
        )
        findViewById<RecyclerView>(R.id.playlistsList).apply {
            layoutManager = LinearLayoutManager(this@QueueActivity)
            adapter = playlistAdapter
        }

        findViewById<Button>(R.id.sleepOffButton).setOnClickListener { sleepTimer.cancel() }
        findViewById<Button>(R.id.sleep15Button).setOnClickListener { sleepTimer.startMinutes(15) }
        findViewById<Button>(R.id.sleep30Button).setOnClickListener { sleepTimer.startMinutes(30) }
        findViewById<Button>(R.id.sleep60Button).setOnClickListener { sleepTimer.startMinutes(60) }
        findViewById<Button>(R.id.sleepEndButton).setOnClickListener { sleepTimer.startEndOfTrack() }

        findViewById<Button>(R.id.savePlaylistButton).setOnClickListener { saveQueueAsPlaylist() }
        findViewById<Button>(R.id.backButton).setOnClickListener { finish() }

        lifecycleScope.launch {
            sleepTimer.state.collect { sleepStatus.text = sleepTimer.statusText() }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshQueue()
        loadPlaylists()
    }

    private fun pm(): PlayerManager = playerManager.get()

    private fun refreshQueue() {
        val entries = pm().currentQueueEntries()
        val current = pm().player.currentMediaItemIndex
        queueAdapter.submitList(entries, current)
        statusText.text = if (entries.isEmpty()) "Hàng chờ trống." else "${entries.size} bài."
    }

    private fun queueTouchCallback() = object : ItemTouchHelper.SimpleCallback(
        ItemTouchHelper.UP or ItemTouchHelper.DOWN,
        ItemTouchHelper.START or ItemTouchHelper.END,
    ) {
        override fun onMove(
            recyclerView: RecyclerView,
            viewHolder: RecyclerView.ViewHolder,
            target: RecyclerView.ViewHolder,
        ): Boolean {
            val from = viewHolder.bindingAdapterPosition
            val to = target.bindingAdapterPosition
            queueAdapter.moveInUi(from, to)
            pm().moveQueueItem(from, to)
            return true
        }

        override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {
            val index = viewHolder.bindingAdapterPosition
            if (pm().removeQueueItem(index)) {
                queueAdapter.removeInUi(index)
            } else {
                // Không xoá được (chỉ còn 1 bài) → vẽ lại để row vuốt biến mất quay về.
                queueAdapter.notifyItemChanged(index)
            }
            refreshQueue()
        }
    }

    private fun loadPlaylists() {
        lifecycleScope.launch {
            try {
                playlistAdapter.submitList(apiClient.listPlaylists())
            } catch (e: Exception) {
                statusText.text = "Lỗi tải playlist: ${e.message}"
            }
        }
    }

    private fun saveQueueAsPlaylist() {
        val name = playlistNameInput.text.toString().trim()
        if (name.isEmpty()) {
            Toast.makeText(this, "Nhập tên playlist.", Toast.LENGTH_SHORT).show()
            return
        }
        // Chỉ bài từ Drive (có file id) mới lưu được — file pick tay không có id Drive.
        val items = pm().currentQueueEntries().mapNotNull { e ->
            if (e.track.id.isEmpty()) return@mapNotNull null
            MusicApiClient.PlaylistItem(
                fileId = e.track.id,
                name = e.track.title,
                artist = e.track.artist,
                title = e.track.title,
                mimeType = e.track.mimeType,
                size = e.track.size,
            )
        }
        if (items.isEmpty()) {
            Toast.makeText(
                this,
                "Hàng chờ không có bài nào từ Drive để lưu.",
                Toast.LENGTH_LONG,
            ).show()
            return
        }
        lifecycleScope.launch {
            try {
                val id = apiClient.createPlaylist(name)
                apiClient.setPlaylistItems(id, items)
                playlistNameInput.text.clear()
                Toast.makeText(
                    this@QueueActivity,
                    "Đã lưu \"$name\" (${items.size} bài).",
                    Toast.LENGTH_SHORT,
                ).show()
                loadPlaylists()
            } catch (e: Exception) {
                Toast.makeText(this@QueueActivity, "Lỗi: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun loadPlaylist(p: MusicApiClient.PlaylistSummary) {
        lifecycleScope.launch {
            statusText.text = "Đang mở \"${p.name}\"…"
            try {
                val items = apiClient.getPlaylistItems(p.id)
                if (items.isEmpty()) {
                    statusText.text = "Playlist trống."
                    return@launch
                }
                val entries = mutableListOf<PlayerManager.QueueEntry>()
                for (it in items) {
                    try {
                        val url = apiClient.streamUrl(it.fileId, this@QueueActivity)
                        entries.add(
                            PlayerManager.QueueEntry(
                                track = MusicApiClient.Track(
                                    id = it.fileId,
                                    title = it.title.ifEmpty { it.name },
                                    size = it.size,
                                    mimeType = it.mimeType,
                                    artist = it.artist,
                                ),
                                url = url,
                                localUri = null,
                            ),
                        )
                    } catch (e: Exception) {
                        // Bỏ qua bài lỗi (vd: file đã xoá trên Drive), giữ các bài còn lại.
                    }
                }
                if (entries.isEmpty()) {
                    statusText.text = "Không mở được bài nào trong playlist."
                    return@launch
                }
                pm().playQueue(entries)
                refreshQueue()
                statusText.text = "Đang phát \"${p.name}\" (${entries.size} bài)."
            } catch (e: Exception) {
                statusText.text = "Lỗi: ${e.message}"
            }
        }
    }

    private fun deletePlaylist(p: MusicApiClient.PlaylistSummary) {
        lifecycleScope.launch {
            try {
                apiClient.deletePlaylist(p.id)
                loadPlaylists()
            } catch (e: Exception) {
                Toast.makeText(this@QueueActivity, "Lỗi: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }
    }
}
