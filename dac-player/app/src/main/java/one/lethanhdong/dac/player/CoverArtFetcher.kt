package one.lethanhdong.dac.player

import android.content.Context
import coil.ImageLoader
import coil.decode.DataSource
import coil.fetch.FetchResult
import coil.fetch.Fetcher
import coil.request.Options
import okio.Buffer
import okio.BufferedSource

/**
 * Ảnh bìa cho danh sách nhạc — plan dac-app 1.4 (Coil).
 *
 * Luồng: TrackAdapter load [CoverArtKey] → [CoverArtFetcher] lấy Drive stream URL
 * (qua [MusicApiClient.streamUrl]) → [MediaMetadataReader] trích ảnh nhúng →
 * Coil cache (disk + memory) theo key. Key gồm track id + file size: file đổi
 * (size đổi) → key đổi → Coil fetch lại, không dùng cache cũ.
 *
 * Không có ảnh nhúng → Fetcher trả null → Coil hiện placeholder (ic_music_note).
 * Không bịa ảnh bìa.
 */

/** Key cho Coil cache: track id + file size. */
data class CoverArtKey(val trackId: String, val size: Long)

object CoverArt {
    /** ImageLoader dùng cho ảnh bìa (gắn CoverArtFetcher). */
    fun imageLoader(context: Context, apiClient: MusicApiClient): ImageLoader =
        ImageLoader.Builder(context)
            .components { add(CoverArtFetcher.Factory(apiClient)) }
            .build()

    /** Đoán mime từ bytes ảnh (JPEG FF D8 / PNG 89 50 4E 47). Null nếu không nhận ra. */
    fun guessMime(art: ByteArray): String? = when {
        art.size >= 2 && art[0] == 0xFF.toByte() && art[1] == 0xD8.toByte() -> "image/jpeg"
        art.size >= 4 && art[0] == 0x89.toByte() && art[1] == 0x50.toByte() &&
            art[2] == 0x4E.toByte() && art[3] == 0x47.toByte() -> "image/png"
        else -> null
    }
}

class CoverArtFetcher(
    private val key: CoverArtKey,
    private val apiClient: MusicApiClient,
) : Fetcher {

    override suspend fun fetch(): FetchResult? {
        return try {
            val url = apiClient.streamUrl(key.trackId)
            val art = MediaMetadataReader.embeddedArtFromUrl(url) ?: return null
            val source: BufferedSource = Buffer().write(art)
            FetchResult.OfSource(
                source = source,
                mimeType = CoverArt.guessMime(art),
                dataSource = DataSource.NETWORK,
            )
        } catch (e: Exception) {
            // Mất mạng / hết token / Drive lỗi → null → Coil hiện placeholder
            null
        }
    }

    class Factory(
        private val apiClient: MusicApiClient,
    ) : Fetcher.Factory<CoverArtKey> {
        override fun create(
            data: CoverArtKey,
            options: Options,
            imageLoader: ImageLoader,
        ): Fetcher = CoverArtFetcher(data, apiClient)
    }
}
