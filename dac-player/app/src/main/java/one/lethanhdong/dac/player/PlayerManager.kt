package one.lethanhdong.dac.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import com.decent.usbaudio.UsbAudioDevice
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jaudiotagger.audio.AudioFileIO

/**
 * Quản lý ExoPlayer + USB bit-perfect sink — theo doc Ma145/decent-player.
 *
 * Thứ tự y chang README của họ:
 *   1. Tạo sink (trong DacRenderersFactory.usbSink)
 *   2. Wrap LoadControl
 *   3. Build player → attachToPlayer()
 *
 * Nguồn verify:
 * - GETTING_STARTED.md ("Quick Integration", "Bit depth is detected automatically")
 * - README.md ("The libraries" — 3 dòng tích hợp UsbAudioSink)
 */
@UnstableApi
class PlayerManager(private val context: Context) {

    private val renderersFactory = DacRenderersFactory(context)

    val player: ExoPlayer = ExoPlayer.Builder(context)
        .setRenderersFactory(renderersFactory)
        .setLoadControl(
            renderersFactory.wrapLoadControl(DefaultLoadControl())
        )
        .setMediaSourceFactory(
            // Đăng ký DsfExtractor để phát file .dsf qua DoP (spec P3 7.1).
            // DefaultExtractorsFactory.createExtractors() đã có sẵn các
            // extractor chuẩn; ta thêm DsfExtractor vào đầu để ưu tiên sniff.
            DefaultMediaSourceFactory(context).setExtractorsFactory {
                val extractors = DefaultExtractorsFactory()
                    .createExtractors().toMutableList()
                extractors.add(0, DsfExtractor())
                extractors.toTypedArray()
            }
        )
        .build()
        .also { exo ->
            // Dòng quan trọng nhất (README ma145):
            // attachToPlayer() tự lo lifecycle NativeAudioEngine, trích track path,
            // giữ seek position, chuyển bài (EOF-to-next-track), và chuyển mượt
            // giữa file local và HTTP stream.
            renderersFactory.usbSink.attachToPlayer(exo)
        }

    /** Phát 1 file local (giữ API cũ cho MainActivity nút pick). */
    fun playLocal(uri: Uri) {
        playSingleLocal(uri, uri.lastPathSegment ?: "audio")
    }

    /**
     * 4.5: Phát 1 track, xoá queue cũ. Title lưu vào MediaMetadata để
     * listener đọc lại khi chuyển bài (không dùng biến pendingTitle rời rạc).
     */
    fun playStream(url: String, title: String = "audio") {
        playSingleStream(url, title)
    }

    fun playSingleStream(url: String, title: String) {
        playQueue(listOf(QueueEntry(synthTrack(title), url, null)))
    }

    fun playSingleLocal(uri: Uri, title: String) {
        playQueue(listOf(QueueEntry(synthTrack(title), null, uri)))
    }

    /**
     * 4.5: Thêm vào cuối queue. ExoPlayer tự chuyển bài gapless khi các
     * track liên tiếp cùng format (không reconfigure sink).
     */
    fun enqueueStream(url: String, title: String) {
        enqueueEntry(QueueEntry(synthTrack(title), url, null))
    }

    fun enqueueLocal(uri: Uri, title: String) {
        enqueueEntry(QueueEntry(synthTrack(title), null, uri))
    }

    // ---------- 4.9: Queue có metadata Track (reorder + lưu playlist) ----------

    /**
     * 1 entry trong queue — giữ Track gốc (có Drive file id) để lưu playlist
     * lên D1 và hiện artist. url = stream Drive, localUri = file đã tải offline.
     */
    data class QueueEntry(
        val track: MusicApiClient.Track,
        val url: String?,
        val localUri: Uri?,
    )

    private val queueEntries = mutableListOf<QueueEntry>()

    private fun synthTrack(title: String): MusicApiClient.Track =
        MusicApiClient.Track(id = "", title = title, size = 0, mimeType = "", artist = "")

    private fun enqueueEntry(entry: QueueEntry) {
        queueEntries.add(entry)
        player.addMediaItem(mediaItem(entry.url ?: entry.localUri.toString(), entry.track.title))
    }

    /**
     * Phát 1 danh sách Track từ vị trí [startIndex] (thay toàn bộ queue cũ).
     * Activity tự resolve URL trước rồi gọi — PlayerManager chỉ giữ entry.
     */
    fun playQueue(entries: List<QueueEntry>, startIndex: Int = 0) {
        require(entries.isNotEmpty())
        val idx = startIndex.coerceIn(entries.indices)
        queueEntries.clear()
        queueEntries.addAll(entries)
        player.clearMediaItems()
        entries.forEach { e ->
            player.addMediaItem(mediaItem(e.url ?: e.localUri.toString(), e.track.title))
        }
        player.seekToDefaultPosition(idx)
        player.prepare()
        player.play()
    }

    /** Queue hiện tại (kể cả bài đang phát) — gọi trên main thread. */
    fun currentQueueEntries(): List<QueueEntry> = queueEntries.toList()

    /** Đổi chỗ 2 bài trong queue (kéo-thả). */
    fun moveQueueItem(from: Int, to: Int) {
        if (from == to || from !in queueEntries.indices || to !in queueEntries.indices) return
        val e = queueEntries.removeAt(from)
        queueEntries.add(to, e)
        player.moveMediaItem(from, to)
    }

    /** Xoá 1 bài khỏi queue — không xoá khi chỉ còn 1 bài. Trả về true nếu đã xoá. */
    fun removeQueueItem(index: Int): Boolean {
        if (queueEntries.size <= 1 || index !in queueEntries.indices) return false
        queueEntries.removeAt(index)
        player.removeMediaItem(index)
        return true
    }

    /** Số bài đang chờ trong queue (không tính bài đang phát). */
    fun queueSize(): Int =
        maxOf(0, player.mediaItemCount - player.currentMediaItemIndex - 1)

    private fun mediaItem(url: String, title: String): MediaItem =
        MediaItem.Builder()
            .setUri(url)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(title).build())
            .build()

    fun togglePlayPause() {
        if (player.isPlaying) player.pause() else player.play()
    }

    fun release() {
        player.release()
    }

    // ---------- 4.4: Badge chất lượng nguồn → DAC ----------

    /** Chất lượng audio đang phát — null khi chưa phát gì. */
    data class AudioQuality(
        val sampleRateHz: Int?,
        val bitDepth: Int?,
        val formatLabel: String,
        val viaUsbDac: Boolean,
    ) {
        /** Badge hiện ở UI: "FLAC • 24-bit • 96 kHz → USB DAC". */
        fun badgeText(): String =
            AudioFormat.badgeText(formatLabel, bitDepth, sampleRateHz, viaUsbDac)
    }

    private val _audioQuality = MutableStateFlow<AudioQuality?>(null)
    val audioQuality: StateFlow<AudioQuality?> = _audioQuality.asStateFlow()

    /** 4.5: title track đang phát (tự cập nhật khi queue chuyển bài). */
    private val _currentTitle = MutableStateFlow<String?>(null)
    val currentTitle: StateFlow<String?> = _currentTitle.asStateFlow()

    /** 4.9: callback khi queue tự chuyển bài (sleep timer "hết bài"). */
    var onAutoTransition: (() -> Unit)? = null

    /**
     * ExoPlayer bắt buộc truy cập trên thread đã tạo (main) — scope này chạy
     * trên Main. Chỉ phần đọc file header (jaudiotagger, blocking) mới
     * chuyển xuống Dispatchers.IO.
     */
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    init {
        player.addListener(object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) {
                updateQuality()
            }

            /** 4.5: queue chuyển bài → cập nhật title + chất lượng. */
            override fun onMediaItemTransition(mediaItem: MediaItem?, reason: Int) {
                _currentTitle.value = mediaItem?.mediaMetadata?.title?.toString()
                updateQuality()
                // 4.9: sleep timer "hết bài" — chỉ khi tự chuyển (không phải bấm tay).
                if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_AUTO) {
                    onAutoTransition?.invoke()
                }
            }
        })
    }

    /**
     * Đọc chất lượng từ track ExoPlayer đang phát:
     * - sampleRate: từ Format (ExoPlayer parse container — đúng cho cả stream).
     * - bitDepth: từ header file local (jaudiotagger); stream không đọc được → null.
     *   File local suy từ URI của media item hiện tại (kể cả bài trong queue).
     * - viaUsbDac: có USB DAC đang cắm không.
     */
    private fun updateQuality() {
        scope.launch {
            // Chạy trên Main — đọc player an toàn.
            val current = player.currentMediaItem
            val title = current?.mediaMetadata?.title?.toString() ?: "audio"
            val format = player.currentTracks.groups
                .firstOrNull { it.type == androidx.media3.common.C.TRACK_TYPE_AUDIO }
                ?.getTrackFormat(0)
            val sampleRate = format?.sampleRate?.takeIf { it > 0 }
            val mime = format?.sampleMimeType ?: ""
            val label = AudioFormat.formatLabel(mime, title)
            val uri = current?.localConfiguration?.uri
            val localFile = if (uri?.scheme == "file") {
                uri.path?.let { File(it) }?.takeIf { it.exists() }
            } else {
                null
            }
            // Đọc header file là blocking → xuống IO.
            val bitDepth = withContext(Dispatchers.IO) {
                localFile?.let { readBitDepth(it) }
            }
            val viaUsb = try {
                UsbAudioDevice.getInstance(context).findUsbAudioDevice() != null
            } catch (e: Exception) {
                false
            }
            _audioQuality.value = AudioQuality(
                sampleRateHz = sampleRate,
                bitDepth = bitDepth,
                formatLabel = label,
                viaUsbDac = viaUsb,
            )
        }
    }

    /** Đọc bit depth từ header file (jaudiotagger 3.x: getBitsPerSample() trả về int). */
    internal fun readBitDepth(file: File): Int? {
        val bps: Int? = try {
            AudioFileIO.read(file).audioHeader?.bitsPerSample
        } catch (e: Exception) {
            null
        }
        return bps?.takeIf { it > 0 }
    }
}
