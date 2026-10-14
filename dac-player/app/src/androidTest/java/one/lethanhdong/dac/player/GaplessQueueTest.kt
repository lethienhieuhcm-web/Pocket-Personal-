package one.lethanhdong.dac.player

import android.content.Context
import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.5: test queue gapless của PlayerManager.
 * Không cần DAC thật, không cần mạng — chỉ kiểm tra playlist mechanics
 * (title metadata, queue size). Dùng URL giả, không tải thật.
 *
 * ExoPlayer bắt buộc truy cập trên thread đã tạo nó → mọi thao tác
 * chạy trên main thread qua runOnMainSync.
 */
@RunWith(AndroidJUnit4::class)
class GaplessQueueTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val instr = InstrumentationRegistry.getInstrumentation()

    private fun withPlayer(block: (PlayerManager) -> Unit) {
        lateinit var pm: PlayerManager
        instr.runOnMainSync { pm = PlayerManager(context) }
        try {
            instr.runOnMainSync { block(pm) }
        } finally {
            instr.runOnMainSync { pm.release() }
        }
    }

    @Test
    fun playSingleStream_setsTitleAndClearsQueue() {
        withPlayer { pm ->
            // Giả lập queue cũ có 2 bài
            pm.enqueueStream("https://example.test/old1.mp3", "Cu A")
            pm.enqueueStream("https://example.test/old2.mp3", "Cu B")
            assertEquals(2, pm.player.mediaItemCount)

            // Phát bài mới → queue cũ bị xoá
            pm.playSingleStream("https://example.test/new.mp3", "Bai Moi")
            // Dừng ngay để không tải thật (prepare đã gọi nhưng chưa kịp chạy)
            pm.player.stop()

            assertEquals(1, pm.player.mediaItemCount)
            assertEquals(
                "Bai Moi",
                pm.player.currentMediaItem?.mediaMetadata?.title?.toString(),
            )
            assertEquals(0, pm.queueSize())
        }
    }

    @Test
    fun enqueueStream_growsQueue() {
        withPlayer { pm ->
            pm.playSingleStream("https://example.test/a.mp3", "A")
            pm.player.stop()
            assertEquals(0, pm.queueSize())

            pm.enqueueStream("https://example.test/b.mp3", "B")
            pm.enqueueStream("https://example.test/c.mp3", "C")

            assertEquals(3, pm.player.mediaItemCount)
            assertEquals(2, pm.queueSize())
            // Title metadata giữ đúng thứ tự
            assertEquals(
                "B",
                pm.player.getMediaItemAt(1).mediaMetadata.title?.toString(),
            )
            assertEquals(
                "C",
                pm.player.getMediaItemAt(2).mediaMetadata.title?.toString(),
            )
        }
    }

    @Test
    fun playSingleLocal_setsTitle() {
        withPlayer { pm ->
            val uri = Uri.parse("file:///sdcard/Music/bai.flac")
            pm.playSingleLocal(uri, "Bai FLAC")
            pm.player.stop()
            assertEquals(
                "Bai FLAC",
                pm.player.currentMediaItem?.mediaMetadata?.title?.toString(),
            )
        }
    }
}
