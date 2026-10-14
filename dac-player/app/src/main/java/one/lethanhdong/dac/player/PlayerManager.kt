package one.lethanhdong.dac.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
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

    /** Phát 1 file local (D1: test với file trong máy trước). */
    fun playLocal(uri: Uri) {
        pendingLocalFile = uri.path?.let { File(it) }?.takeIf { it.exists() }
        pendingTitle = uri.lastPathSegment ?: "audio"
        player.setMediaItem(MediaItem.fromUri(uri))
        player.prepare()
        player.play()
    }

    /** Phát HTTP(S) URL — D3: stream từ R2. ExoPlayer pipeline xử lý,
     *  vẫn bit-perfect qua UsbAudioSink (theo ARCHITECTURE.md). */
    fun playStream(url: String, title: String = "audio") {
        pendingLocalFile = null
        pendingTitle = title
        player.setMediaItem(MediaItem.fromUri(url))
        player.prepare()
        player.play()
    }

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

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var pendingLocalFile: File? = null
    private var pendingTitle: String = "audio"

    init {
        player.addListener(object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) {
                updateQuality()
            }
        })
    }

    /**
     * Đọc chất lượng từ track ExoPlayer đang phát:
     * - sampleRate: từ Format (ExoPlayer parse container — đúng cho cả stream).
     * - bitDepth: từ header file local (jaudiotagger); stream không đọc được → null.
     * - viaUsbDac: có USB DAC đang cắm không.
     */
    private fun updateQuality() {
        scope.launch {
            val format = player.currentTracks.groups
                .firstOrNull { it.type == androidx.media3.common.C.TRACK_TYPE_AUDIO }
                ?.getTrackFormat(0)
            val sampleRate = format?.sampleRate?.takeIf { it > 0 }
            val mime = format?.sampleMimeType ?: ""
            val label = AudioFormat.formatLabel(mime, pendingTitle)
            val bitDepth = pendingLocalFile?.let { readBitDepth(it) }
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

    /** Đọc bit depth từ header file (jaudiotagger). Null nếu không đọc được. */
    internal fun readBitDepth(file: File): Int? {
        val bps: String? = try {
            AudioFileIO.read(file).audioHeader?.bitsPerSample
        } catch (e: Exception) {
            null
        }
        return bps?.toIntOrNull()?.takeIf { it > 0 }
    }
}
