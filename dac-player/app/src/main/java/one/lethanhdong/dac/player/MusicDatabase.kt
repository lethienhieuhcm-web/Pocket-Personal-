package one.lethanhdong.dac.player

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * 2.3: Room database cho music library cache.
 * Thay SharedPreferences JSON — query offline, không giới hạn size.
 */
@Database(entities = [TrackEntity::class], version = 1, exportSchema = false)
abstract class MusicDatabase : RoomDatabase() {
    abstract fun trackDao(): TrackDao

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
                ).build().also { INSTANCE = it }
            }
    }
}
