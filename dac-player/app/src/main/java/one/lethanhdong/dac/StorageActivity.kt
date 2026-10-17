package one.lethanhdong.dac

import android.os.Bundle
import android.os.StatFs
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.OfflineManager
import javax.inject.Inject

/**
 * v3.0: Màn hình Bộ nhớ — quản lý file nhạc offline.
 * - Hiện dung lượng đã dùng / còn trống
 * - Nút xoá tất cả file offline
 * - Cảnh báo khi bộ nhớ thấp
 */
@AndroidEntryPoint
class StorageActivity : AppCompatActivity() {

    @Inject lateinit var offlineManager: OfflineManager

    private lateinit var tvUsed: TextView
    private lateinit var tvFree: TextView
    private lateinit var tvCount: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
        }

        val title = TextView(this).apply {
            text = "Bộ nhớ"
            textSize = 24f
        }
        tvUsed = TextView(this).apply { textSize = 16f }
        tvFree = TextView(this).apply { textSize = 16f }
        tvCount = TextView(this).apply { textSize = 16f }

        val btnClear = Button(this).apply {
            text = "Xoá tất cả file offline"
        }
        val btnBack = Button(this).apply {
            text = "Quay lại"
        }

        layout.addView(title)
        layout.addView(tvUsed)
        layout.addView(tvFree)
        layout.addView(tvCount)
        layout.addView(btnClear)
        layout.addView(btnBack)
        setContentView(layout)

        btnClear.setOnClickListener {
            lifecycleScope.launch {
                try {
                    val tracks = offlineManager.downloadedTracks()
                    tracks.forEach { offlineManager.delete(it.trackId) }
                    Toast.makeText(this@StorageActivity, "Đã xoá ${tracks.size} file", Toast.LENGTH_SHORT).show()
                    refreshStats()
                } catch (e: Exception) {
                    Toast.makeText(this@StorageActivity, "Lỗi: ${e.message}", Toast.LENGTH_SHORT).show()
                }
            }
        }
        btnBack.setOnClickListener { finish() }

        refreshStats()
    }

    private fun refreshStats() {
        lifecycleScope.launch {
            try {
                val tracks = offlineManager.downloadedTracks()
                var totalBytes = 0L
                // Tính tổng dung lượng (OfflineManager lưu file local)
                tracks.forEach { t ->
                    offlineManager.localFile(t.trackId)?.let { totalBytes += it.length() }
                }
                tvUsed.text = "Đã dùng: ${fmtSize(totalBytes)}"
                tvCount.text = "Số file offline: ${tracks.size}"

                val stat = StatFs(filesDir.path)
                val freeBytes = stat.availableBytes
                tvFree.text = "Còn trống: ${fmtSize(freeBytes)}"

                // Cảnh báo khi còn < 1GB
                if (freeBytes < 1024L * 1024 * 1024) {
                    tvFree.text = "Còn trống: ${fmtSize(freeBytes)} ⚠️ Sắp hết!"
                }
            } catch (e: Exception) {
                tvUsed.text = "Lỗi tải thông tin"
            }
        }
    }

    private fun fmtSize(bytes: Long): String {
        return when {
            bytes >= 1073741824 -> "%.1f GB".format(bytes / 1073741824.0)
            bytes >= 1048576 -> "%.1f MB".format(bytes / 1048576.0)
            bytes >= 1024 -> "%d KB".format(bytes / 1024)
            else -> "$bytes B"
        }
    }
}
