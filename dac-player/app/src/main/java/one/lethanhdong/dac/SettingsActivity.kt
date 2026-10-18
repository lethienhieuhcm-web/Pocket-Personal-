package one.lethanhdong.dac

import android.os.Bundle
import android.widget.Button
import android.widget.ImageButton
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import dagger.hilt.android.AndroidEntryPoint
import one.lethanhdong.dac.player.AudioCacheManager
import one.lethanhdong.dac.player.DacSettings

/**
 * Màn hình Cài đặt — thiết kế v4.
 *
 * - Phát nhạc: Gapless toggle
 * - Cache: dung lượng + xóa
 * - Tài khoản: đăng xuất
 * - Thông tin: phiên bản + giấy phép
 */
@AndroidEntryPoint
class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_settings)

        findViewById<ImageButton>(R.id.backButton).setOnClickListener {
            finish()
        }

        // Gapless toggle
        val gaplessSwitch = findViewById<Switch>(R.id.gaplessSwitch)
        gaplessSwitch.isChecked = DacSettings.isGaplessEnabled(this)
        gaplessSwitch.setOnCheckedChangeListener { _, isChecked ->
            DacSettings.setGaplessEnabled(this, isChecked)
            Toast.makeText(this,
                if (isChecked) "Đã bật gapless" else "Đã tắt gapless",
                Toast.LENGTH_SHORT).show()
        }

        // Cache size
        val cacheManager = AudioCacheManager(this)
        val cacheSizeValue = findViewById<TextView>(R.id.cacheSizeValue)
        updateCacheSizeLabel(cacheSizeValue, cacheManager)

        findViewById<android.view.View>(R.id.cacheSizeRow).setOnClickListener {
            showCacheSizeDialog(cacheManager, cacheSizeValue)
        }

        // Clear cache
        findViewById<Button>(R.id.clearCacheButton).setOnClickListener {
            val size = cacheManager.cacheSize()
            cacheManager.clear()
            Toast.makeText(this,
                "Đã xóa ${formatBytes(size)} cache",
                Toast.LENGTH_SHORT).show()
        }

        // Logout
        findViewById<Button>(R.id.logoutButton).setOnClickListener {
            // TODO: implement logout
            Toast.makeText(this, "Đăng xuất", Toast.LENGTH_SHORT).show()
        }

        // Version
        try {
            val pInfo = packageManager.getPackageInfo(packageName, 0)
            findViewById<TextView>(R.id.versionValue).text = pInfo.versionName
        } catch (e: Exception) {
            findViewById<TextView>(R.id.versionValue).text = "—"
        }

        // Licenses
        findViewById<Button>(R.id.licensesButton).setOnClickListener {
            // TODO: open licenses
            Toast.makeText(this, "Giấy phép", Toast.LENGTH_SHORT).show()
        }
    }

    private fun updateCacheSizeLabel(view: TextView, manager: AudioCacheManager) {
        val mb = manager.getMaxSize(this) / (1024 * 1024)
        view.text = if (mb >= 1024) "${mb / 1024} GB" else "$mb MB"
    }

    private fun showCacheSizeDialog(manager: AudioCacheManager, label: TextView) {
        val options = arrayOf("500 MB", "1 GB", "2 GB", "5 GB")
        val values = longArrayOf(500, 1024, 2048, 5120)
        val current = manager.getMaxSize(this) / (1024 * 1024)
        val checked = values.indexOfFirst { it == current }.coerceAtLeast(1)

        AlertDialog.Builder(this)
            .setTitle("Dung lượng cache tối đa")
            .setSingleChoiceItems(options, checked) { dialog, which ->
                manager.setMaxSize(this, values[which])
                updateCacheSizeLabel(label, manager)
                dialog.dismiss()
            }
            .setNegativeButton("Hủy", null)
            .show()
    }

    private fun formatBytes(bytes: Long): String {
        return when {
            bytes >= 1024 * 1024 * 1024 -> String.format("%.1f GB", bytes / (1024.0 * 1024 * 1024))
            bytes >= 1024 * 1024 -> String.format("%.1f MB", bytes / (1024.0 * 1024))
            else -> String.format("%d KB", bytes / 1024)
        }
    }
}
