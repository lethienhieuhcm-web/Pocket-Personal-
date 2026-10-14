package one.lethanhdong.dac.player

import android.content.Context
import dagger.hilt.android.qualifiers.ApplicationContext
import java.io.File
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

/**
 * 4.3: Quản lý file nhạc tải về để nghe offline.
 *
 * - File lưu ở filesDir/offline/{trackId}.{ext} (app-private).
 * - Metadata (tên, size, thời gian tải) lưu Room bảng offline_tracks.
 * - PlayerManager/Activity kiểm tra [localFile] trước khi stream:
 *   có file local → phát offline, không → stream từ Drive.
 *
 * Thiết kế theo big-tech (Spotify/YouTube Music): download là per-track,
 * có thể xoá từng bài; không tự động tải (tốn data/bộ nhớ của user).
 */
@Singleton
class OfflineManager @Inject constructor(
    @ApplicationContext private val context: Context,
    private val dao: OfflineTrackDao,
) {
    /** Thư mục chứa file offline. Internal để test có thể trỏ sang thư mục tạm. */
    internal val storageDir: File by lazy {
        File(context.filesDir, "offline").apply { mkdirs() }
    }

    /** File local của track, hoặc null nếu chưa tải. */
    suspend fun localFile(trackId: String): File? = withContext(Dispatchers.IO) {
        val e = dao.getById(trackId) ?: return@withContext null
        val f = File(storageDir, e.fileName)
        if (f.exists() && f.length() > 0) f else null
    }

    /** Track đã được tải về chưa. */
    suspend fun isDownloaded(trackId: String): Boolean = localFile(trackId) != null

    /**
     * Tải track về máy. [streamUrl] lấy từ apiClient.streamUrl(trackId).
     * Ghi file tạm rồi rename (atomic) — file đang tải dở không bao giờ
     * bị nhầm là đã tải xong.
     */
    suspend fun download(
        trackId: String,
        trackTitle: String,
        streamUrl: String,
        onProgress: (downloaded: Long, total: Long) -> Unit = { _, _ -> },
    ): File = withContext(Dispatchers.IO) {
        val ext = extForFileName(trackTitle)
        val fileName = fileNameFor(trackId, ext)
        val tmp = File(storageDir, "$fileName.tmp")
        val dest = File(storageDir, fileName)
        val req = Request.Builder().url(streamUrl).get().build()
        ApiHttp.client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                throw IllegalStateException("Tải thất bại: HTTP ${resp.code}")
            }
            val body = resp.body ?: throw IllegalStateException("Body rỗng")
            val total = body.contentLength()
            var downloaded = 0L
            tmp.outputStream().use { out ->
                body.byteStream().use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        downloaded += n
                        onProgress(downloaded, total)
                    }
                }
            }
        }
        if (!tmp.renameTo(dest)) {
            tmp.delete()
            throw IllegalStateException("Không lưu được file")
        }
        dao.insert(
            OfflineTrackEntity(
                trackId = trackId,
                fileName = fileName,
                size = dest.length(),
                downloadedAt = System.currentTimeMillis(),
            )
        )
        dest
    }

    /** Xoá file offline của track (giải phóng bộ nhớ). */
    suspend fun delete(trackId: String): Unit = withContext(Dispatchers.IO) {
        val e = dao.getById(trackId)
        if (e != null) File(storageDir, e.fileName).delete()
        dao.deleteById(trackId)
    }

    /** Danh sách track đã tải (để hiện màn hình quản lý sau này). */
    suspend fun downloadedTracks(): List<OfflineTrackEntity> = withContext(Dispatchers.IO) {
        dao.getAll()
    }

    companion object {
        /** Đuôi file từ tên track — mặc định mp3 nếu không đoán được. */
        fun extForFileName(name: String): String {
            val ext = name.substringAfterLast('.', "").lowercase()
            return if (ext.length in 2..5 && ext.all { it.isLetterOrDigit() }) ext else "mp3"
        }

        /** Tên file local: {trackId}.{ext} — trackId Drive là duy nhất. */
        fun fileNameFor(trackId: String, ext: String): String {
            val safeId = trackId.filter { it.isLetterOrDigit() || it == '-' || it == '_' }
            return "$safeId.$ext"
        }
    }
}
