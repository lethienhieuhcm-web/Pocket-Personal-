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
        player.clearMediaItems()
        player.setMediaItem(mediaItem(url, title))
        player.prepare()
        player.play()
    }

    fun playSingleLocal(uri: Uri, title: String) {
        player.clearMediaItems()
        player.setMediaItem(mediaItem(uri.toString(), title))
        player.prepare()
        player.play()
    }

    /**
     * 4.5: Thêm vào cuối queue. ExoPlayer tự chuyển bài gapless khi các
     * track liên tiếp cùng format (không reconfigure sink).
     */
    fun enqueueStream(url: String, title: String) {
        player.addMediaItem(mediaItem(url, title))
    }

    fun enqueueLocal(uri: Uri, title: String) {
        player.addMediaItem(mediaItem(uri.toString(), title))
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
