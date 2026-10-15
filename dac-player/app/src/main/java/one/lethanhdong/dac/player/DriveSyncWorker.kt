package one.lethanhdong.dac.player

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

/**
 * v3.0: Worker đồng bộ thư viện nhạc nền mỗi 6 giờ.
 * - Chỉ chạy khi có WiFi (tiết kiệm data)
 * - Gọi POST /api/dac/sync (server tự lấy Drive token từ D1)
 * - Cập nhật Room cache (folders + tracks)
 */
@HiltWorker
class DriveSyncWorker @AssistedInject constructor(
    @Assisted context: Context,
    @Assisted params: WorkerParameters,
    private val api: MusicApiClient,
    private val db: MusicDatabase,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return try {
            // Sync incremental từ Drive → D1 (server-side, không cần token client)
            api.syncIndex()
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 3) Result.retry() else Result.failure()
        }
    }

    companion object {
        private const val WORK_NAME = "drive_sync"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<DriveSyncWorker>(6, TimeUnit.HOURS)
                .setConstraints(
                    androidx.work.Constraints.Builder()
                        .setRequiredNetworkType(androidx.work.NetworkType.UNMETERED)
                        .setRequiresCharging(false)
                        .build()
                )
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                req
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}
