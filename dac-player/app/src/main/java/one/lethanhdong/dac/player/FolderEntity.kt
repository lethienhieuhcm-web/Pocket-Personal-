package one.lethanhdong.dac.player

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query

/**
 * v3.0: Room entity cho folder cache.
 * Lưu cấu trúc thư mục để duyệt offline/nhanh (<50ms),
 * không cần gọi API mỗi lần mở folder.
 */
@Entity(tableName = "folders")
data class FolderEntity(
    @PrimaryKey val id: String,
    val name: String,
    val parentId: String,
    /** Path đầy đủ vd "/Nhạc/FLAC/" — để hiện breadcrumb không cần API. */
    val path: String = "",
    val cachedAt: Long = System.currentTimeMillis(),
)

@Dao
interface FolderDao {
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(folders: List<FolderEntity>)

    @Query("SELECT * FROM folders WHERE parentId = :parentId ORDER BY name")
    suspend fun getChildren(parentId: String): List<FolderEntity>

    @Query("SELECT * FROM folders WHERE id = :id")
    suspend fun getById(id: String): FolderEntity?

    @Query("DELETE FROM folders")
    suspend fun clear()

    @Query("SELECT COUNT(*) FROM folders")
    suspend fun count(): Int
}
