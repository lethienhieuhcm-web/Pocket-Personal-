package one.lethanhdong.dac.player

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * 2.3: Room entity cho music library cache.
 * Thay SharedPreferences JSON (MusicApiClient) — query được offline,
 * survive app restart, không giới hạn kích thước như SharedPreferences.
 */
@Entity(tableName = "tracks")
data class TrackEntity(
    @PrimaryKey val id: String,
    val title: String,
    val size: Long,
    val mimeType: String,
    /** Thời điểm cache (epoch millis) — để check TTL 24h. */
    val cachedAt: Long = System.currentTimeMillis(),
)
