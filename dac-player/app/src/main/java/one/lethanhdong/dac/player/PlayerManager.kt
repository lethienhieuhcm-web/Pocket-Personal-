package one.lethanhdong.dac.player

import android.content.Context
import android.net.Uri
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer

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
        player.setMediaItem(MediaItem.fromUri(uri))
        player.prepare()
        player.play()
    }

    /** Phát HTTP(S) URL — D3: stream từ R2. ExoPlayer pipeline xử lý,
     *  vẫn bit-perfect qua UsbAudioSink (theo ARCHITECTURE.md). */
    fun playStream(url: String) {
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
}
