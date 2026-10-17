package one.lethanhdong.dac.player

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query

/**
 * DAO cho bảng dac_quirks.
 */
@Dao
interface DacQuirkDao {
    @Query("SELECT * FROM dac_quirks WHERE dacKey = :dacKey")
    suspend fun getQuirks(dacKey: String): List<DacQuirk>

    @Query("SELECT * FROM dac_quirks WHERE dacKey = :dacKey AND quirkType = :type LIMIT 1")
    suspend fun getQuirk(dacKey: String, type: String): DacQuirk?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insert(quirk: DacQuirk)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(quirks: List<DacQuirk>)

    @Query("DELETE FROM dac_quirks WHERE dacKey = :dacKey AND userOverride = 1")
    suspend fun clearUserOverrides(dacKey: String)

    @Query("SELECT COUNT(*) FROM dac_quirks")
    suspend fun count(): Int
}
