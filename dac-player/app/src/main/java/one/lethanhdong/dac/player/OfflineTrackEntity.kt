package one.lethanhdong.dac.player

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * 4.3: Metadata file nhạc đã tải về để nghe offline.
 * File thật nằm ở filesDir/offline/{trackId}.{ext} — app-private, không cần
 * quyền storage. Xoá app → mất file (đúng chuẩn big-tech cho cache offline).
 */
@Entity(tableName = "offline_tracks")
data class OfflineTrackEntity(
    @PrimaryKey val trackId: String,
    val fileName: String,
    val size: Long,
    val downloadedAt: Long,
)
