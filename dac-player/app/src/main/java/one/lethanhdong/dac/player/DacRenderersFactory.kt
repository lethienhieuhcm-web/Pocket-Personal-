package one.lethanhdong.dac.player

import android.content.Context
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.LoadControl
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.DefaultAudioSink
import com.decent.usbaudio.UsbAudioSink

/**
 * RenderersFactory tích hợp USB bit-perfect — y chang
 * Ma145/decent-player docs/libs/GETTING_STARTED.md ("Quick Integration").
 *
 * Nguồn verify: https://github.com/Ma145/decent-player/blob/main/docs/libs/GETTING_STARTED.md
 *
 * Thứ tự đúng theo README của họ (3 dòng tích hợp):
 *   1. val sink = UsbAudioSink(delegate, context)          → tạo sink TRƯỚC
 *   2. val loadControl = UsbAudioSink.wrapLoadControl(...) → wrap load control
 *   3. sink.attachToPlayer(player)                         → attach sau build()
 *
 * Vì vậy sink được tạo eager (lazy val), không đợi buildAudioSink().
 */
@UnstableApi
class DacRenderersFactory(context: Context) : DefaultRenderersFactory(context) {

    private val appContext = context.applicationContext

    /**
     * UsbAudioSink dùng chung cho cả pipeline.
     * Tạo 1 lần duy nhất, dùng cho buildAudioSink() + wrapLoadControl() + attachToPlayer().
     */
    val usbSink: UsbAudioSink by lazy {
        // Phát hiện libFLAC lúc runtime — y chang doc:
        // - Có libFLAC  → decode FLAC ra integer thô tại extractor (zero float)
        // - Không có    → FFmpeg decode ra float32, driver chuyển ngược bằng x·2^N
        //               (chính xác tuyệt đối với 16/24-bit)
        val hasLibFlac = try {
            Class.forName("androidx.media3.decoder.flac.LibflacAudioRenderer")
            true
        } catch (_: ClassNotFoundException) {
            false
        }

        val delegate = DefaultAudioSink.Builder(appContext)
            .setEnableFloatOutput(!hasLibFlac)
            .build()

        // Dòng tích hợp lõi: wrap delegate bằng UsbAudioSink.
        // UsbAudioSink tự phát hiện encoding (float vs integer) trong handleBuffer()
        // và route sang enqueue(FloatArray) hoặc enqueueRaw(ByteArray).
        UsbAudioSink(delegate, appContext)
    }

    init {
        // Bắt buộc theo doc: ép dùng FFmpeg extension cho format không phải FLAC,
        // vì decoder built-in của Android (MediaCodec) cắt 24-bit xuống 16-bit.
        setExtensionRendererMode(EXTENSION_RENDERER_MODE_PREFER)
    }

    override fun buildAudioSink(
        context: Context,
        enableFloatOutput: Boolean,
        enableOffload: Boolean
    ): AudioSink = usbSink

    /**
     * LoadControl wrapper — y chang README của ma145:
     * dừng ExoPlayer load file khi NativeAudioEngine đang active
     * (tránh tranh chấp I/O, theo docs/libs/ARCHITECTURE.md).
     */
    fun wrapLoadControl(defaultLoadControl: DefaultLoadControl): LoadControl {
        return UsbAudioSink.wrapLoadControl(defaultLoadControl) {
            usbSink.isNativeEngineActive
        }
    }
}
