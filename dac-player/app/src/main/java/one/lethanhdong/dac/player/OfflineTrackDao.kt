package one.lethanhdong.dac.player

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

/** 4.3: DAO cho bảng offline_tracks. */
@Dao
interface OfflineTrackDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(e: OfflineTrackEntity)

    @Query("DELETE FROM offline_tracks WHERE trackId = :id")
    suspend fun deleteById(id: String)

    @Query("SELECT * FROM offline_tracks WHERE trackId = :id")
    suspend fun getById(id: String): OfflineTrackEntity?

    @Query("SELECT * FROM offline_tracks ORDER BY downloadedAt DESC")
    suspend fun getAll(): List<OfflineTrackEntity>
}
