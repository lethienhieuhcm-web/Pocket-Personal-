package one.lethanhdong.dac.player

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.9: test queue reorder/remove của PlayerManager.
 * Không cần DAC thật, không cần mạng — URL giả, dừng ngay sau prepare.
 * Mọi thao tác ExoPlayer trên main thread (quy tắc 4.5).
 */
@RunWith(AndroidJUnit4::class)
class QueueReorderTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val instr = InstrumentationRegistry.getInstrumentation()

    private fun entry(title: String, id: String = ""): PlayerManager.QueueEntry =
        PlayerManager.QueueEntry(
            track = MusicApiClient.Track(id = id, title = title, size = 0, mimeType = ""),
            url = "https://example.test/$title.mp3",
            localUri = null,
        )

    private fun withPlayer(block: (PlayerManager) -> Unit) {
        lateinit var pm: PlayerManager
        instr.runOnMainSync { pm = PlayerManager(context) }
        try {
            instr.runOnMainSync { block(pm) }
        } finally {
            instr.runOnMainSync { pm.release() }
        }
    }

    private fun titles(pm: PlayerManager): List<String> =
        pm.currentQueueEntries().map { it.track.title }

    @Test
    fun playQueue_keepsEntriesInOrder() {
        withPlayer { pm ->
            pm.playQueue(listOf(entry("A"), entry("B"), entry("C")))
            pm.player.stop()
            assertEquals(listOf("A", "B", "C"), titles(pm))
            assertEquals(3, pm.player.mediaItemCount)
        }
    }

    @Test
    fun moveQueueItem_reordersBothLists() {
        withPlayer { pm ->
            pm.playQueue(listOf(entry("A"), entry("B"), entry("C")))
            pm.player.stop()
            pm.moveQueueItem(0, 2)
            assertEquals(listOf("B", "C", "A"), titles(pm))
            // ExoPlayer cũng đổi theo
            assertEquals(
                "A",
                pm.player.getMediaItemAt(2).mediaMetadata.title?.toString(),
            )
            // Di chuyển về lại
            pm.moveQueueItem(2, 0)
            assertEquals(listOf("A", "B", "C"), titles(pm))
        }
    }

    @Test
    fun moveQueueItem_outOfRangeIsNoOp() {
        withPlayer { pm ->
            pm.playQueue(listOf(entry("A"), entry("B")))
            pm.player.stop()
            pm.moveQueueItem(0, 5)
            pm.moveQueueItem(-1, 1)
            pm.moveQueueItem(1, 1)
            assertEquals(listOf("A", "B"), titles(pm))
            assertEquals(2, pm.player.mediaItemCount)
        }
    }

    @Test
    fun removeQueueItem_shrinksQueue() {
        withPlayer { pm ->
            pm.playQueue(listOf(entry("A"), entry("B"), entry("C")))
            pm.player.stop()
            pm.removeQueueItem(1)
            assertEquals(listOf("A", "C"), titles(pm))
            assertEquals(2, pm.player.mediaItemCount)
        }
    }

    @Test
    fun removeQueueItem_keepsLastItem() {
        withPlayer { pm ->
            pm.playSingleStream("https://example.test/solo.mp3", "Solo")
            pm.player.stop()
            pm.removeQueueItem(0)
            assertEquals(listOf("Solo"), titles(pm))
            assertEquals(1, pm.player.mediaItemCount)
        }
    }

    @Test
    fun legacyEnqueue_keepsEntriesInSync() {
        withPlayer { pm ->
            // API cũ (playSingleStream/enqueueStream) vẫn đồng bộ queueEntries.
            pm.playSingleStream("https://example.test/a.mp3", "A")
            pm.enqueueStream("https://example.test/b.mp3", "B")
            pm.player.stop()
            assertEquals(listOf("A", "B"), titles(pm))
            assertEquals(2, pm.player.mediaItemCount)
        }
    }
}
