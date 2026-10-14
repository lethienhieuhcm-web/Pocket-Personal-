package one.lethanhdong.dac

import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.launch
import one.lethanhdong.dac.player.CopyScopeException
import one.lethanhdong.dac.player.DriveCopyManager
import one.lethanhdong.dac.player.ImportFileAdapter

/**
 * ImportActivity — nhập nhạc từ Google Drive share link — plan dac-app 2.1.
 *
 * Luồng:
 * 1. User dán link → "Kiểm tra" → Worker resolve → hiện danh sách file nhạc
 * 2. User chọn file (mặc định tất cả) → "Copy N file"
 * 3. Hiện tiến trình x/y → copy từng file qua Worker (server-side)
 * 4. Xong → Toast kết quả → "Xong" về MainActivity (tự refresh library)
 *
 * Lỗi scope (D7): hiện hướng dẫn cấp quyền, không hiện như lỗi chung.
 */
class ImportActivity : AppCompatActivity() {

    private lateinit var copyManager: DriveCopyManager
    private lateinit var fileAdapter: ImportFileAdapter

    private lateinit var linkInput: EditText
    private lateinit var resolveButton: Button
    private lateinit var statusText: TextView
    private lateinit var copyProgress: ProgressBar
    private lateinit var fileList: RecyclerView
    private lateinit var copyButton: Button
    private lateinit var doneButton: Button

    private var copying = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_import)

        copyManager = DriveCopyManager(this)

        linkInput = findViewById(R.id.linkInput)
        resolveButton = findViewById(R.id.resolveButton)
        statusText = findViewById(R.id.importStatus)
        copyProgress = findViewById(R.id.copyProgress)
        fileList = findViewById(R.id.importFileList)
        copyButton = findViewById(R.id.copyButton)
        doneButton = findViewById(R.id.doneButton)

        fileAdapter = ImportFileAdapter()
        fileList.layoutManager = LinearLayoutManager(this)
        fileList.adapter = fileAdapter

        resolveButton.setOnClickListener { doResolve() }
        copyButton.setOnClickListener { doCopy() }
        doneButton.setOnClickListener { finish() }
    }

    private fun doResolve() {
        val link = linkInput.text.toString()
        if (link.isBlank()) {
            Toast.makeText(this, "Dán link Drive vào trước", Toast.LENGTH_SHORT).show()
            return
        }
        lifecycleScope.launch {
            setBusy(true)
            statusText.text = "Đang kiểm tra link..."
            try {
                val res = copyManager.resolve(link, this@ImportActivity)
                if (res.files.isEmpty()) {
                    statusText.text = "Không tìm thấy file nhạc nào trong link này"
                    copyButton.isEnabled = false
                    return@launch
                }
                fileAdapter.setFiles(res.files)
                val label = if (res.isFolder) "thư mục \"${res.name}\"" else "file \"${res.name}\""
                statusText.text = "Tìm thấy ${res.files.size} file nhạc trong $label"
                copyButton.text = "Copy ${res.files.size} file"
                copyButton.isEnabled = true
            } catch (e: Exception) {
                statusText.text = "Lỗi: ${e.message}"
                copyButton.isEnabled = false
            } finally {
                setBusy(false)
            }
        }
    }

    private fun doCopy() {
        val selected = fileAdapter.selectedFiles()
        if (selected.isEmpty()) {
            Toast.makeText(this, "Chọn ít nhất 1 file để copy", Toast.LENGTH_SHORT).show()
            return
        }
        lifecycleScope.launch {
            copying = true
            setBusy(true)
            copyProgress.visibility = View.VISIBLE
            copyProgress.max = selected.size
            copyProgress.progress = 0
            copyButton.isEnabled = false
            resolveButton.isEnabled = false

            var ok = 0
            var failed = 0
            var scopeError: String? = null

            for ((i, f) in selected.withIndex()) {
                statusText.text = "Đang copy ${i + 1}/${selected.size}: ${f.name}"
                try {
                    copyManager.copy(f.id, f.name, this@ImportActivity)
                    ok++
                } catch (e: CopyScopeException) {
                    // D7: dừng ngay, hiện hướng dẫn — copy tiếp cũng fail
                    scopeError = e.message
                    failed = selected.size - i
                    break
                } catch (e: Exception) {
                    failed++
                }
                copyProgress.progress = i + 1
            }

            copying = false
            setBusy(false)
            copyProgress.visibility = View.GONE
            resolveButton.isEnabled = true

            statusText.text = when {
                scopeError != null -> "Dừng: $scopeError"
                failed == 0 -> "Copy xong $ok file ✓ Vào thư viện để phát nhạc"
                else -> "Copy xong $ok file, lỗi $failed file"
            }
            if (scopeError == null && failed == 0) {
                Toast.makeText(this@ImportActivity, "Copy xong $ok file", Toast.LENGTH_LONG).show()
            }
        }
    }

    private fun setBusy(busy: Boolean) {
        resolveButton.isEnabled = !busy
        // copyButton chỉ enable khi có file và không đang copy
        if (!copying) copyButton.isEnabled = !busy && fileAdapter.itemCount > 0
        linkInput.isEnabled = !busy
    }
}
