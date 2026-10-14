package one.lethanhdong.dac.player

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * 2.3: WorkManager Worker cho Drive copy chạy nền.
 * Tiếp tục chạy kể cả khi app bị background (khác với ImportActivity chỉ chạy khi mở).
 *
 * Input: sourceIds (String array), driveToken được lấy từ DriveAuthManager trong Worker.
 * Progress: cập nhật qua setProgress() — UI observe qua WorkManager.getWorkInfoByIdLiveData().
 */
class DriveCopyWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    companion object {
        const val KEY_SOURCE_IDS = "source_ids"
        const val KEY_DEST_NAMES = "dest_names"
        const val PROGRESS_COPIED = "copied"
        const val PROGRESS_TOTAL = "total"
        const val OUTPUT_COPIED_IDS = "copied_ids"
    }

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val sourceIds = inputData.getStringArray(KEY_SOURCE_IDS) ?: return@withContext Result.failure()
        val destNames = inputData.getStringArray(KEY_DEST_NAMES) ?: Array(sourceIds.size) { "" }
        if (sourceIds.isEmpty()) return@withContext Result.failure()

        val copyManager = DriveCopyManager(applicationContext)
        val copiedIds = mutableListOf<String>()

        for ((index, sourceId) in sourceIds.withIndex()) {
            // Kiểm tra cancel
            if (isStopped) return@withContext Result.failure()

            try {
                val destName = destNames.getOrNull(index)?.takeIf { it.isNotEmpty() } ?: ""
                // activity=null: dùng token cache; nếu hết hạn cần UI thì worker fail,
                // user retry từ app (giới hạn chấp nhận được cho background copy).
                val result = copyManager.copy(sourceId, destName, activity = null)
                copiedIds.add(result.copiedId)

                // Báo progress
                setProgress(
                    Data.Builder()
                        .putInt(PROGRESS_COPIED, index + 1)
                        .putInt(PROGRESS_TOTAL, sourceIds.size)
                        .build()
                )
            } catch (e: Exception) {
                // 1 file lỗi → ghi log, tiếp tục file khác (không fail cả batch)
                // TODO: lưu lỗi vào output để UI hiện
                continue
            }
        }

        Result.success(
            Data.Builder()
                .putStringArray(OUTPUT_COPIED_IDS, copiedIds.toTypedArray())
                .build()
        )
    }
}
