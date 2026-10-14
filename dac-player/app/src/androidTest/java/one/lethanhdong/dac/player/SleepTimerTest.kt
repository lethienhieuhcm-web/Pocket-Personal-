package one.lethanhdong.dac.player

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * 4.9: test SleepTimer — không cần DAC thật, không cần mạng.
 * Timer chạy trên Main; mọi thao tác qua runOnMainSync (quy tắc 4.5).
 */
@RunWith(AndroidJUnit4::class)
class SleepTimerTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val instr = InstrumentationRegistry.getInstrumentation()

    private fun withTimer(block: (PlayerManager, SleepTimer) -> Unit) {
        lateinit var pm: PlayerManager
        lateinit var timer: SleepTimer
        instr.runOnMainSync {
            pm = PlayerManager(context)
            timer = SleepTimer(pm)
        }
        try {
            block(pm, timer)
        } finally {
            instr.runOnMainSync {
                timer.cancel()
                pm.release()
            }
        }
    }

    private fun onMain(block: () -> Unit) {
        instr.runOnMainSync { block() }
    }

    @Test
    fun countdown_firesAndPauses() {
        lateinit var pm: PlayerManager
        lateinit var timer: SleepTimer
        onMain {
            pm = PlayerManager(context)
            timer = SleepTimer(pm)
            pm.playSingleStream("https://example.test/a.mp3", "A")
            timer.startMs(1500)
        }
        assertTrue(timer.state.value is SleepTimer.State.Countdown)
        try {
            // Chờ timer chạy xong: poll state tới khi Off (timeout 8s).
            val deadline = System.currentTimeMillis() + 8000
            var off = false
            while (System.currentTimeMillis() < deadline && !off) {
                onMain { off = timer.state.value is SleepTimer.State.Off }
                if (!off) Thread.sleep(200)
            }
            onMain {
                assertTrue("timer phải tắt sau khi hết giờ", timer.state.value is SleepTimer.State.Off)
                assertFalse("player phải pause khi hết giờ", pm.player.isPlaying)
            }
        } finally {
            onMain {
                timer.cancel()
                pm.release()
            }
        }
    }

    @Test
    fun cancel_stopsCountdown() {
        withTimer { _, timer ->
            onMain {
                timer.startMs(60_000)
                assertTrue(timer.state.value is SleepTimer.State.Countdown)
                timer.cancel()
                assertTrue(timer.state.value is SleepTimer.State.Off)
            }
        }
    }

    @Test
    fun endOfTrack_setsState() {
        withTimer { _, timer ->
            onMain {
                timer.startEndOfTrack()
                assertTrue(timer.state.value is SleepTimer.State.EndOfTrack)
                timer.cancel()
                assertTrue(timer.state.value is SleepTimer.State.Off)
            }
        }
    }
}
