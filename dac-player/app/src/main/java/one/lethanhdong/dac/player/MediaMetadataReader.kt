package one.lethanhdong.dac.player

import android.media.MediaMetadataRetriever
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Đọc metadata + ảnh bìa nhúng từ file nhạc — plan dac-app 1.4.
 *
 * Nguồn ảnh bìa DUY NHẤT là ảnh nhúng trong file (FLAC PICTURE / MP3 APIC / ...).
 * Không bịa ảnh bìa, không dùng ảnh giả: file không có ảnh nhúng → trả null,
 * UI hiện placeholder (ic_music_note) — rõ ràng là "chưa có bìa", không giả vờ là bìa thật.
 *
 * MediaMetadataRetriever là Android SDK (không cần thêm dependency).
 * `setDataSource(url)` đọc metadata bằng HTTP range request — chỉ đọc phần đầu
 * file (nơi chứa ảnh nhúng), không tải cả file.
 */
object MediaMetadataReader {

    /** Metadata đọc từ file (title/artist/album/duration). Null nếu không đọc được. */
    data class Metadata(
        val title: String?,
        val artist: String?,
        val album: String?,
        /** Thời lượng (ms), null nếu không đọc được. */
        val durationMs: Long?,
    )

    /** Ảnh bìa nhúng (bytes JPEG/PNG) từ URL remote (Drive stream URL). Null nếu không có. */
    suspend fun embeddedArtFromUrl(url: String): ByteArray? = withContext(Dispatchers.IO) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(url, HashMap())
            retriever.embeddedPicture
        } catch (e: Exception) {
            null
        } finally {
            runCatching { retriever.release() }
        }
    }

    /** Ảnh bìa nhúng từ file local (đường dẫn). Null nếu không có. Dùng cho test. */
    suspend fun embeddedArtFromPath(path: String): ByteArray? = withContext(Dispatchers.IO) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(path)
            retriever.embeddedPicture
        } catch (e: Exception) {
            null
        } finally {
            runCatching { retriever.release() }
        }
    }

    /** Metadata (title/artist/album/duration) từ file local. Null nếu không đọc được. */
    suspend fun readFromPath(path: String): Metadata? = withContext(Dispatchers.IO) {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(path)
            Metadata(
                title = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE),
                artist = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST),
                album = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM),
                durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                    ?.toLongOrNull(),
            )
        } catch (e: Exception) {
            null
        } finally {
            runCatching { retriever.release() }
        }
    }
}
