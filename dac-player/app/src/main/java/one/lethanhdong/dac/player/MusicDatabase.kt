package one.lethanhdong.dac.player

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * 2.3: Room database cho music library cache.
 * Thay SharedPreferences JSON — query offline, không giới hạn size.
 *
 * 4.3: version 2 — thêm bảng offline_tracks (file nhạc tải về nghe offline).
 * Dùng fallbackToDestructiveMigration: đây là cache (tải lại được), không phải
 * data người dùng nhập — xoá và build lại schema an toàn.
 */
@Database(
    entities = [TrackEntity::class, OfflineTrackEntity::class, FolderEntity::class, DacQuirk::class],
    version = 4,
    exportSchema = false,
)
abstract class MusicDatabase : RoomDatabase() {
    abstract fun trackDao(): TrackDao
    abstract fun offlineTrackDao(): OfflineTrackDao
    abstract fun folderDao(): FolderDao
    abstract fun dacQuirkDao(): DacQuirkDao

    companion object {
        private const val DB_NAME = "dac_music.db"

        @Volatile
        private var INSTANCE: MusicDatabase? = null

        fun getInstance(context: Context): MusicDatabase =
            INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    MusicDatabase::class.java,
                    DB_NAME
                )
                    .fallbackToDestructiveMigration()
                    .build().also { INSTANCE = it }
            }
    }
}
