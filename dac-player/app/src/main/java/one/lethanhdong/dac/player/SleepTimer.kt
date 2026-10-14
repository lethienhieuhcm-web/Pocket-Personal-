package one.lethanhdong.dac.player

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * 4.9: Hẹn giờ dừng phát (sleep timer) — singleton, sống qua chuyển màn hình.
 * - Tắt / 15 / 30 / 60 phút: đếm ngược trên Main, hết giờ tự pause player.
 * - Hết bài: pause ngay khi PlayerManager báo queue tự chuyển bài.
 * UI là panel inline trong QueueActivity (không dialog/popup, theo quy tắc).
 */
class SleepTimer(private val playerManager: PlayerManager) {

    sealed interface State {
        data object Off : State
        data class Countdown(val remainingMs: Long) : State
        data object EndOfTrack : State
    }

    private val scope = CoroutineScope(Dispatchers.Main.immediate + SupervisorJob())
    private val _state = MutableStateFlow<State>(State.Off)
    val state: StateFlow<State> = _state
    private var job: Job? = null

    init {
        // Chế độ "hết bài": chỉ kích hoạt khi state đang là EndOfTrack.
        playerManager.onAutoTransition = {
            if (_state.value is State.EndOfTrack) {
                _state.value = State.Off
                playerManager.player.pause()
            }
        }
    }

    /** Bắt đầu đếm ngược [minutes] phút, hết giờ tự pause. */
    fun startMinutes(minutes: Int) {
        startMs(minutes * 60_000L)
    }

    /** Dùng cho test: đếm ngược mili-giây tuỳ ý. */
    internal fun startMs(ms: Long) {
        cancel()
        require(ms > 0)
        _state.value = State.Countdown(ms)
        job = scope.launch {
            var left = ms
            while (left > 0) {
                delay(minOf(1000L, left))
                left -= minOf(1000L, left)
                _state.value = State.Countdown(left)
            }
            _state.value = State.Off
            playerManager.player.pause()
        }
    }

    /** Chế độ "dừng khi hết bài đang phát". */
    fun startEndOfTrack() {
        cancel()
        _state.value = State.EndOfTrack
    }

    fun cancel() {
        job?.cancel()
        job = null
        if (_state.value != State.Off) _state.value = State.Off
    }

    /** Chuỗi hiển thị: "tắt" / "còn 24:31" / "dừng khi hết bài". */
    fun statusText(): String = when (val s = _state.value) {
        is State.Off -> "Hẹn giờ: tắt"
        is State.EndOfTrack -> "Hẹn giờ: dừng khi hết bài đang phát"
        is State.Countdown -> {
            val totalSec = s.remainingMs / 1000
            "Hẹn giờ: còn %d:%02d".format(totalSec / 60, totalSec % 60)
        }
    }
}
