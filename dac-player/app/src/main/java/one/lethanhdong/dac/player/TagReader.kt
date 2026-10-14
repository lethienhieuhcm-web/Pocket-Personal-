package one.lethanhdong.dac.player

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jaudiotagger.audio.AudioFileIO
import org.jaudiotagger.tag.FieldKey
import java.io.File

/**
 * 2.3: Đọc metadata audio bằng jaudiotagger (Apache license).
 * Dùng cho file local (đã tải về) — đọc title/artist/album/cover art từ tag.
 * Không dùng cho stream (dùng MediaMetadataReader cho stream như 1.4).
 */
object TagReader {

    data class AudioTags(
        val title: String?,
        val artist: String?,
        val album: String?,
        val year: String?,
        val genre: String?,
        val trackNumber: String?,
    )

    /**
     * Đọc tags từ file audio. Trả về null nếu file không đọc được.
     * Chạy trên IO dispatcher (jaudiotagger đọc file blocking).
     */
    suspend fun readTags(file: File): AudioTags? = withContext(Dispatchers.IO) {
        try {
            val audioFile = AudioFileIO.read(file)
            val tag = audioFile.tag ?: return@withContext null
            AudioTags(
                title = tag.getFirst(FieldKey.TITLE).takeIf { it.isNotEmpty() },
                artist = tag.getFirst(FieldKey.ARTIST).takeIf { it.isNotEmpty() },
                album = tag.getFirst(FieldKey.ALBUM).takeIf { it.isNotEmpty() },
                year = tag.getFirst(FieldKey.YEAR).takeIf { it.isNotEmpty() },
                genre = tag.getFirst(FieldKey.GENRE).takeIf { it.isNotEmpty() },
                trackNumber = tag.getFirst(FieldKey.TRACK).takeIf { it.isNotEmpty() },
            )
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Kiểm tra file có phải audio được hỗ trợ không (dựa vào đuôi file).
     */
    fun isSupported(fileName: String): Boolean {
        val ext = fileName.substringAfterLast('.', "").lowercase()
        return ext in setOf("mp3", "flac", "wav", "m4a", "ogg", "opus", "wma", "aiff", "aif")
    }
}
