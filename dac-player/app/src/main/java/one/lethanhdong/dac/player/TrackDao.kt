package one.lethanhdong.dac.player

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

/**
 * 2.3: DAO cho music library cache.
 */
@Dao
interface TrackDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(tracks: List<TrackEntity>)

    @Query("SELECT * FROM tracks ORDER BY title ASC")
    suspend fun getAll(): List<TrackEntity>

    @Query("SELECT * FROM tracks WHERE id = :id LIMIT 1")
    suspend fun getById(id: String): TrackEntity?

    @Query("SELECT COUNT(*) FROM tracks")
    suspend fun count(): Int

    /** Thời điểm cache cũ nhất — để check TTL. */
    @Query("SELECT MIN(cachedAt) FROM tracks")
    suspend fun oldestCachedAt(): Long?

    @Query("DELETE FROM tracks")
    suspend fun clear()

    @Query("SELECT * FROM tracks WHERE title LIKE '%' || :query || '%' ORDER BY title ASC")
    suspend fun search(query: String): List<TrackEntity>
}
